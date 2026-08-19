/**
 * Obsidian 导入对话框 —— FR-09 的唯一交互入口，M3 批次点亮。
 *
 * 【为什么是一张卡而不是「点了就导」】导入要落在**用户的知识库**里，三件事必须让他先看见：
 * 导到哪个 Vault、放进哪个子目录、撞上同名笔记怎么办。少问一件，就可能在别人经营多年的
 * 库里悄悄多一个文件或少一篇笔记——这是本应用唯一会往用户目录写东西的功能，
 * 谨慎程度要配得上它的破坏力。
 *
 * 【职责边界】
 *   本文件      选项 UI + 调 ipc 执行导入 + 把结果交回调用方；
 *   obsidian.rs Vault 枚举、拷贝、附件重写、URI 唤起（后端已实装，本文件一字不改）；
 *   App.tsx     何时唤起（右键菜单「导入 Obsidian…」）、结果 toast；
 *   ipc.ts      listVaults / importToVault / openInObsidian 的封装。
 * 本文件不自己弹 toast——导入完成时卡片已经关了，提示条必须由还活着的 App 来渲染。
 *
 * 【「未检测到 Obsidian」不是错误】`list_vaults` 在读不到 obsidian.json 时**返回空数组**
 * 而不是报错（没装 Obsidian 是一种正常状态）。所以空列表走的是引导文案，不是错误页；
 * 只有真正读失败（%APPDATA% 缺失、JSON 损坏、无权限）才显示失败行 + 重试。
 *
 * 【没有落点探测，就不假装有】导出对话框那套「落点已被占用」预警在这里没有对应的后端命令，
 * 与其猜一个可能是错的结论，不如把冲突策略摆在明面上并写清它的边界：
 * 覆盖只作用于**笔记本身**，附件在 Rust 侧永不覆盖（同名不同内容一律改名）。
 *
 * 【唤起失败 ≠ 导入失败】文件此时已经躺在 Vault 里了。`openInObsidian` 抛错只在成功文案
 * 后面补一句，绝不把整次导入报成失败——那会让用户以为要重导一遍，于是 Vault 里多出一份副本。
 *
 * 【视觉】沿用导出对话框那张卡的语义类（rounded-card / border-float / bg-layer /
 * shadow-lv3），一个新 CSS 类都不加；交互反馈只换背景色、不加 transition。
 *
 * 纪律：不 import @tauri-apps/api（ESLint 强制，一律走 services/ipc.ts）；
 * 不写内联中文文案（注释除外），全部取自 i18n/zh-CN.ts 的 obsidianDialog 组。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { t } from "../i18n/zh-CN";
import { importToVault, listVaults, openInObsidian } from "../services/ipc";
import { describeError } from "../stores/fileSession";
import type { ConflictPolicy, Vault } from "../types";

/* ── 对外契约（App.tsx 按这三个类型接线） ─────────────────────── */

export interface ObsidianImportRequest {
  /** 当前文档的绝对路径：后端据此读原文、扫附件（全程只读） */
  readonly sourcePath: string;
}

/**
 * 导入结局。形状与 ExportOutcome / ShareOutcome 同构，App 复用同一个 ExportToast 渲染，
 * 不必为导入再造一套提示条。`output` 是笔记在 Vault 里的绝对路径，
 * 供 toast 的「打开文件 / 打开所在文件夹」使用。
 */
export type ObsidianImportOutcome =
  | { readonly ok: true; readonly message: string; readonly output?: string }
  | { readonly ok: false; readonly message: string };

export interface ObsidianImportDialogProps {
  readonly request: ObsidianImportRequest;
  /**
   * 导入中/导入结束的开关。App 据此决定遮罩点击是否放行——
   * 导入进行中关掉卡片并不能让后端停下来（文件可能已经拷了一半），
   * 只会让用户失去唯一的进度反馈。
   */
  readonly onBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
  readonly onDone: (outcome: ObsidianImportOutcome) => void;
}

/* ── 常量（技术值，不是文案） ─────────────────────────────────── */

/** 超过这个时长才显示进度说明（DG 6.6：>2s 追加提示，避免"点了没反应"） */
const SLOW_HINT_MS = 2000;

/** Vault 枚举的三态：加载中 / 读失败 / 已就绪（空数组 = 没装 Obsidian，属就绪） */
type LoadPhase = "loading" | "failed" | "ready";

/* ── 路径工具 ───────────────────────────────────────────────── */

/**
 * 子目录输入 → 展示用的分量列表。
 *
 * 与 Rust 的 `split_clean_components` 保持同样的取舍：空段、`.`、`..` 一律丢掉
 * （不允许把文件写到 Vault 外面去）。**刻意不复刻后端的非法字符清洗**——那属于
 * 落盘细节，在这里演一遍只会让预览与真实结果在边角上对不上，不如少承诺一点。
 */
function cleanSubfolderComponents(raw: string): string[] {
  return raw
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Vault 根 + Vault 内相对路径 → 绝对路径（toast 的「打开所在文件夹」要用）。
 * 后端回传的 relativePath 是正斜杠形态，这里换回反斜杠交给资源管理器。
 *
 * 盘根 Vault（`D:\`）裁掉尾分隔符会剩下 `D:`，再拼 `\笔记.md` 仍是 `D:\笔记.md`，
 * 依旧是绝对路径，不会退化成「盘符相对路径」（那才是 `D:笔记.md`）。
 */
function joinVaultPath(vaultPath: string, relativePath: string): string {
  const root = vaultPath.replace(/[\\/]+$/, "");
  return `${root}\\${relativePath.replace(/\//g, "\\")}`;
}

/* ── 图标（与 ExportDialog/ShareDialog 同一套画法：24 视窗 / stroke 1.5 / currentColor） ── */

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

/** 单选：选中时圆心实心点（与导出对话框同一画法） */
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

/** 警示：三角感叹号。覆盖策略那条警告靠它一眼可辨，而不只是把字染成 warn 色 */
function IconWarn() {
  return (
    <Glyph size={14}>
      <path d="M12 4.8 20.2 19H3.8L12 4.8Z" />
      <path d="M12 10v3.6M12 16.4h.01" />
    </Glyph>
  );
}

/** 按钮内的 10px 微 spinner：颜色跟随按钮文字（与 ExportDialog 同一实现） */
function MicroSpinner() {
  return (
    <span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 animate-spin-micro rounded-full border-[1.5px]"
      // 关键词而非色值（红线 14 禁的是裸色值）：借按钮自身的 currentColor
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
 * 一行可选项：左侧 16px 标记槽 + 主文案 + 一行淡字说明。
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
        {hint === undefined ? null : <span className="block text-ui-xs text-tertiary">{hint}</span>}
      </span>
    </button>
  );
}

/* ── Vault 行 ───────────────────────────────────────────────── */

interface VaultRowProps {
  readonly vault: Vault;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}

/**
 * 一个 Vault：名字 +（当前打开）标记 + 完整路径。
 *
 * 路径必须露出来：同名 Vault（`笔记` 在 D 盘和移动硬盘上各一个）在只显示名字时
 * 完全无法分辨，而选错的代价是文件进了另一个知识库。长路径截尾并挂 title，
 * 不用 dir=rtl 那类技巧——它会把 Windows 路径的冒号与反斜杠重排，读起来是错的。
 */
function VaultRow({ vault, checked, disabled, onSelect }: VaultRowProps) {
  return (
    <button
      type="button"
      role="radio"
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
        <IconRadio checked={checked} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui text-primary">{vault.name}</span>
          {vault.open ? (
            <span className="flex h-4 shrink-0 items-center rounded-chip bg-hover px-1.5 text-ui-xs text-secondary">
              {t.obsidianDialog.vaultOpen}
            </span>
          ) : null}
        </span>
        <span title={vault.path} className="block truncate text-ui-xs text-tertiary">
          {vault.path}
        </span>
      </span>
    </button>
  );
}

/* ── 对话框本体 ─────────────────────────────────────────────── */

export function ObsidianImportDialog({
  request,
  onBusyChange,
  onClose,
  onDone,
}: ObsidianImportDialogProps) {
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [vaults, setVaults] = useState<readonly Vault[]>([]);
  /** 枚举失败的面向用户的原因（Rust AppError.message 本就是中文） */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subfolder, setSubfolder] = useState("");
  /** 默认改名：覆盖是不可逆的，不该是默认值 */
  const [conflict, setConflict] = useState<ConflictPolicy>("rename");
  /** 导入完还要不要唤起 Obsidian——绝大多数人导完就想去看，故默认开 */
  const [openAfter, setOpenAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const slowTimer = useRef<number | undefined>(undefined);
  /** 卡片被卸载后不再 setState（导入仍在后端跑，结果由 onDone 交给 App） */
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(slowTimer.current);
    };
  }, []);

  // 忙碌位上抛给 App（遮罩点击据此放行或吃掉）
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  /* ── Vault 枚举（空数组 = 没装 Obsidian，不是故障） ── */

  const reload = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    void (async () => {
      try {
        const found = await listVaults();
        if (!mounted.current) {
          return;
        }
        setVaults(found);
        // 后端已把「当前打开」排在最前，这里仍显式找一遍：默认值不该依赖排序的副作用
        setSelectedId(found.find((vault) => vault.open)?.id ?? found[0]?.id ?? null);
        setPhase("ready");
      } catch (error: unknown) {
        console.warn("[obsidian] list vaults failed", error);
        if (!mounted.current) {
          return;
        }
        setVaults([]);
        setSelectedId(null);
        setLoadError(describeError(error).message);
        setPhase("failed");
      }
    })();
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /* ── 派生值 ── */

  const selectedVault = useMemo(
    () => vaults.find((vault) => vault.id === selectedId) ?? null,
    [selectedId, vaults],
  );

  const subfolderComponents = useMemo(
    () => cleanSubfolderComponents(subfolder),
    [subfolder],
  );

  const targetDisplay = useMemo(() => {
    if (selectedVault === null) {
      return null;
    }
    const folder = subfolderComponents.join("/");
    return folder === ""
      ? t.obsidianDialog.targetRoot(selectedVault.name)
      : t.obsidianDialog.targetSub(selectedVault.name, folder);
  }, [selectedVault, subfolderComponents]);

  const canImport = !busy && selectedVault !== null;

  /* ── 导入 ── */

  const runImport = useCallback(() => {
    if (busy || selectedVault === null) {
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
        const folder = subfolderComponents.join("/");
        const outcome = await importToVault({
          source: request.sourcePath,
          vaultId: selectedVault.id,
          // 空 = Vault 根目录；显式传 null 而不是空串，与 Rust 的 Option<String> 对齐
          subfolder: folder === "" ? null : folder,
          // conflict 在 Rust 侧无 serde default，必须显式传
          conflict,
        });

        // 唤起失败不算导入失败：文件已经在 Vault 里了，报成失败会诱导用户重导一遍
        let openFailed = false;
        if (openAfter) {
          try {
            await openInObsidian(outcome.uri);
          } catch (error: unknown) {
            console.warn("[obsidian] open uri failed", error);
            openFailed = true;
          }
        }

        // 附件数为 0 时不说这句废话（"已一并复制 0 个附件"只是噪声）
        const base =
          outcome.attachmentCount > 0
            ? t.obsidianDialog.doneWithAttachments(
                outcome.relativePath,
                outcome.attachmentCount,
              )
            : t.obsidianDialog.done(outcome.relativePath);
        onDone({
          ok: true,
          message: openFailed ? t.obsidianDialog.doneOpenFailed(base) : base,
          output: joinVaultPath(selectedVault.path, outcome.relativePath),
        });
      } catch (error: unknown) {
        // Rust AppError 的 message 已经是面向用户的中文（Vault 不存在 / 源文件不存在 /
        // 无写权限），原样交给 toast 比套一句"导入失败"有用得多
        console.warn("[obsidian] import failed", error);
        onDone({ ok: false, message: describeError(error).message });
      } finally {
        window.clearTimeout(slowTimer.current);
        if (mounted.current) {
          setBusy(false);
          setSlow(false);
        }
      }
    })();
  }, [busy, conflict, onDone, openAfter, request.sourcePath, selectedVault, subfolderComponents]);

  /* ── 键盘：Esc 关闭（进行中吃掉）+ Tab 焦点陷阱（DG 6.5） ── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      // 捕获阶段吃掉：本卡是最上层，App 的 Esc 语义链不该同时响应
      event.preventDefault();
      event.stopPropagation();
      // 导入进行中一律不关：卡片是这一刻唯一的进度反馈，关了就只剩干等
      if (!busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [busy, onClose]);

  /**
   * Tab 不许跑出卡片。选择器同时收 button 与 input：子目录输入框是本卡唯一的
   * 非按钮可聚焦元素，漏了它就会出现「Shift+Tab 能进、Tab 出不来」的怪圈。
   */
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

  /* ── Vault 段的四种形态 ── */

  const vaultSection: ReactNode =
    phase === "loading" ? (
      <p className="px-2 py-1.5 text-ui-sm text-tertiary">{t.obsidianDialog.vaultLoading}</p>
    ) : phase === "failed" ? (
      <div className="px-2 py-1.5">
        <p className="text-ui-sm text-warn">{t.obsidianDialog.vaultLoadFailed}</p>
        {loadError === null ? null : (
          <p className="mt-0.5 break-all text-ui-xs text-tertiary">{loadError}</p>
        )}
        <button
          type="button"
          onClick={reload}
          className="mt-1 flex h-row items-center rounded-row px-2 text-ui-sm text-primary hover:bg-hover"
        >
          {t.common.retry}
        </button>
      </div>
    ) : vaults.length === 0 ? (
      // 没装 Obsidian 是正常状态而不是故障：给引导与出路，不给错误页
      <div className="rounded-row border px-2.5 py-2">
        <p className="text-ui text-primary">{t.obsidianDialog.notInstalledTitle}</p>
        <p className="mt-0.5 text-ui-xs text-tertiary">{t.obsidianDialog.notInstalledBody}</p>
        <button
          type="button"
          onClick={reload}
          className="mt-1.5 flex h-row items-center rounded-row px-2 text-ui-sm text-primary hover:bg-hover"
        >
          {t.common.retry}
        </button>
      </div>
    ) : (
      // 只有一个 Vault 时同样列出来：静默替用户决定"导到哪个库"是最不该省的一步
      <div role="radiogroup" aria-label={t.obsidianDialog.vault}>
        {vaults.map((vault) => (
          <VaultRow
            key={vault.id}
            vault={vault}
            checked={vault.id === selectedId}
            disabled={busy}
            onSelect={() => {
              setSelectedId(vault.id);
            }}
          />
        ))}
      </div>
    );

  const optionsDisabled = busy || selectedVault === null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-mask p-6 animate-fade-in"
      // 导入进行中点遮罩不关窗：后端停不下来，关掉只会丢掉唯一的进度反馈
      onClick={busy ? undefined : onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.obsidianDialog.title}
        aria-busy={busy ? true : undefined}
        onKeyDown={onTrapKeyDown}
        // 卡内点击不该关窗（用户会想选中路径复制）
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-card border border-float bg-layer p-4 shadow-lv3"
      >
        <p className="text-ui font-medium text-primary">{t.obsidianDialog.title}</p>

        {/* Vault 选择 */}
        <p className="mt-3 text-ui-sm text-tertiary">{t.obsidianDialog.vault}</p>
        {/* 加载结果要念出来：屏幕阅读器用户看不到列表从"正在查找"变成三行 Vault */}
        <div className="mt-1" aria-live="polite">
          {vaultSection}
        </div>

        {/* 子目录（可空 = Vault 根目录） */}
        <p className="mt-3 text-ui-sm text-tertiary">{t.obsidianDialog.subfolder}</p>
        <div
          className={`mt-1 flex h-input items-center rounded-row border bg-card px-2.5 ${
            optionsDisabled ? "opacity-40" : "focus-within:border-brand"
          }`}
        >
          <input
            type="text"
            value={subfolder}
            disabled={optionsDisabled}
            onChange={(event) => {
              setSubfolder(event.target.value);
            }}
            placeholder={t.obsidianDialog.subfolderPlaceholder}
            spellCheck={false}
            autoComplete="off"
            // 外层那道边框就是输入框的边框，里面再画一道会变成"框里套框"（铁律 6）
            className="min-w-0 flex-1 border-none bg-transparent text-ui text-primary outline-none placeholder:text-caption"
          />
        </div>
        <p className="mt-1 text-ui-xs text-tertiary">{t.obsidianDialog.subfolderHint}</p>
        {/* 落点：把"留空 = 根目录"这句抽象规则变成一行具体的、看得见的结果。
            文件名那句同样是承诺的一部分——扩展名会被改写成 .md，不说清就是隐瞒 */}
        {targetDisplay === null ? null : (
          <>
            <p className="mt-1 text-ui-xs text-tertiary">
              <span className="text-caption">{t.obsidianDialog.target}</span> {targetDisplay}
            </p>
            <p className="text-ui-xs text-tertiary">{t.obsidianDialog.targetNameHint}</p>
          </>
        )}

        {/* 同名冲突：改名（默认）/ 覆盖 */}
        <p className="mt-3 text-ui-sm text-tertiary">{t.obsidianDialog.conflict}</p>
        <div className="mt-1" role="radiogroup" aria-label={t.obsidianDialog.conflict}>
          <OptionRow
            role="radio"
            checked={conflict === "rename"}
            label={t.obsidianDialog.conflictRename}
            hint={t.obsidianDialog.conflictRenameHint}
            disabled={optionsDisabled}
            onSelect={() => {
              setConflict("rename");
            }}
          />
          <OptionRow
            role="radio"
            checked={conflict === "overwrite"}
            label={t.obsidianDialog.conflictOverwrite}
            hint={t.obsidianDialog.conflictOverwriteHint}
            disabled={optionsDisabled}
            onSelect={() => {
              setConflict("overwrite");
            }}
          />
        </div>
        {/* 覆盖不可逆，所以警告必须在按下导入之前就在那儿，而不是事后弹确认框。
            同时划清边界：会被替换的只有笔记本身，附件在 Rust 侧永不覆盖 */}
        {conflict === "overwrite" ? (
          <p className="mt-1 flex items-start gap-1.5 px-2 text-ui-xs text-warn animate-fade-in">
            <span aria-hidden className="mt-0.5 shrink-0">
              <IconWarn />
            </span>
            <span className="min-w-0 flex-1">{t.obsidianDialog.conflictOverwriteWarning}</span>
          </p>
        ) : null}

        {/* 导入后唤起 Obsidian */}
        <div className="mt-2">
          <OptionRow
            role="checkbox"
            checked={openAfter}
            label={t.obsidianDialog.openAfter}
            hint={t.obsidianDialog.openAfterHint}
            disabled={optionsDisabled}
            onSelect={() => {
              setOpenAfter(!openAfter);
            }}
          />
        </div>

        <div className="mt-4 flex items-center justify-end gap-1">
          {/* 超过 2s 才出现（大文档要扫附件、拷图，几秒是正常的） */}
          {slow ? (
            <span className="mr-auto min-w-0 truncate text-ui-xs text-tertiary animate-fade-in">
              {t.obsidianDialog.slowHint}
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
            // 打开即可直接回车导入：Vault 与策略都有默认值，多数场景一步到位
            autoFocus
            aria-disabled={canImport ? undefined : true}
            // 置灰时 tooltip 只写功能名：能力是有的，只是此刻还没有可导入的 Vault，
            // 挂「开发中」会是彻头彻尾的谎话（后端早已实装）
            title={canImport ? undefined : t.obsidianDialog.title}
            onClick={canImport ? runImport : undefined}
            className={`flex h-btn items-center gap-2 rounded-btn bg-brand px-3.5 text-ui font-medium text-inverted ${
              canImport ? "hover:bg-brand-hover" : "cursor-default opacity-60"
            }`}
          >
            {busy ? <MicroSpinner /> : null}
            {busy ? t.obsidianDialog.running : t.obsidianDialog.run}
          </button>
        </div>
      </div>
    </div>
  );
}
