/**
 * 设置页 —— 已有偏好项的**唯一**总入口（左栏底部「设置」唤起）。
 *
 * 【它为什么存在】theme / fontSize / zoomPercent / readingWidth / codeWrap /
 * frontmatterDisplay / htmlExportMode 这七项此前全都是「store 有、持久化有、CSS 有，
 * 界面上没有」——setCodeWrap、setFontSize、setFrontmatterDisplay 三个 setter 的调用点
 * 数量是 0。能力写完了而用户从界面上碰不到，等于功能不存在，本项目已经栽过两次。
 * 本卡不新增任何能力，只是给这些既有 setter 一个入口。
 *
 * 【为什么是「左侧分区导航 + 右侧内容区」而不是一列】上一版把七项从上到下堆在一张
 * max-w-md 的窄卡里，每项底下再挂一段两句话的说明——七项 × 三行，版面被说明文字撑散，
 * 用户既看不出哪些设置是一类，也无从跳到想改的那一项。改成宽卡 + 分区导航之后：
 *   - 归类由导航承担（外观 / 阅读 / 导出与分享），一屏只呈现一个分区；
 *   - 跨行才说得清的话（字号与缩放的分工）上移成**分区说明**，每行只留一句短说明；
 *   - 每行「左标签 + 右控件」对齐成一条纵轴，控件的起始位置不再随文案长短漂移。
 * 结构取自 deepseekHarness 设置卡的实测无障碍快照（navigation + 内容区 + 底部次要动作），
 * 本项目的视觉规范（DG 第 5 章）本就从那份实测里提取，两边同源。
 *
 * 【为什么没有「确定 / 取消」】这是只读查看器的偏好设置，不是表单提交：每一项都
 * **即时生效并即时落盘**（store 的 setter 自带 200ms 节流写盘）。给一个"确定"按钮
 * 反而要求用户先在脑子里模拟一遍效果再提交，而这些选项的效果就写在他眼前的正文上。
 * 于是底栏只有「关闭」一个动作（左侧那行淡字负责把这件事说明白），卡里也不需要
 * busy 位——没有任何异步动作可跑。参考实现底栏那个「打开配置文件」这里刻意不做：
 * 本应用严格只读，不提供绕过 UI 直接改配置文件的入口。
 *
 * 【职责边界】
 *   本文件   偏好项的 UI + 调 settings store 的 setter；
 *   App.tsx  何时唤起、Esc 语义链、把 settings.readingWidth 落到阅读容器的
 *            data-reading-width 上、以及「飞书凭据」这一格的实际卡片（LarkSettingsDialog）；
 *   store    钳位、迁移、落盘（stores/settings.ts 是这些值的唯一事实来源）。
 * 本卡**不直连 ipc**，也不自己弹 toast：它改的每一项都在用户眼前立刻可见，
 * 再补一条"已保存"的提示条只是噪音。
 *
 * 【飞书为什么只是一个按钮】凭据表单有自己的状态机（读状态 / 保存 / 测试连接 / 解除绑定，
 * 全是异步）、自己的密钥可见性开关和二次确认，塞进这张卡会让「改个字号」和
 * 「填一串密钥」共用一个焦点陷阱。这里只留一个入口，卡片仍是 LarkSettingsDialog。
 *
 * 【视觉】沿用导出/飞书那张卡的语义类（rounded-card / border-float / bg-layer /
 * shadow-lv3），左栏用 bg-panel + border-l1 与主区分层（同 App 左栏的写法），
 * 分段控件是「bg-panel 轨道 + bg-layer 选中块」，一个新 CSS 类、一个新依赖都不加；
 * 交互反馈只换背景色、不加 transition。
 *
 * 纪律：不 import @tauri-apps/api（ESLint 强制，一律走 services/ipc.ts）；
 * 不写内联中文文案（注释除外），全部取自 i18n/zh-CN.ts 的 settingsDialog 组。
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { t } from "../i18n/zh-CN";
import {
  FONT_SIZE_PRESETS,
  READING_WIDTHS,
  ZOOM_PRESETS,
  useSettingsStore,
} from "../stores/settings";
import type { ExportHtmlMode, FrontmatterDisplay, ReadingWidth, Theme } from "../types";

/* ── 对外契约（App.tsx 按这个形状接线，与 ExportDialog / LarkSettingsDialog 同构） ── */

export interface SettingsDialogProps {
  readonly onClose: () => void;
  /**
   * 「飞书凭据」那一格的按钮。App 收到之后**先关本卡再开飞书卡**——
   * 两张卡同时在场会有两个焦点陷阱互相抢 Tab，Esc 也说不清该关哪一张。
   */
  readonly onOpenLark: () => void;
}

/* ── 图标（与 App/ExportDialog 同一套画法：24 视窗 / stroke 1.5 / currentColor） ── */

function Glyph({
  size = 16,
  children,
}: {
  readonly size?: number;
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
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

/** 外观分区：半明半暗的对比圆。不用太阳——太阳在同一屏里已经是「浅色」那一档的意思 */
function IconContrast() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** 阅读分区：摊开的书 */
function IconBook() {
  return (
    <Glyph>
      <path d="M12 6.6S10 4.6 4.5 4.6v12.8C10 17.4 12 19.4 12 19.4s2-2 7.5-2V4.6C14 4.6 12 6.6 12 6.6Z" />
      <path d="M12 6.6v12.8" />
    </Glyph>
  );
}

/** 导出与分享分区：出盒的上箭头（与 App 顶栏导出钮同一画法） */
function IconExport() {
  return (
    <Glyph>
      <path d="M12 15V4m0 0-3.5 3.5M12 4l3.5 3.5" />
      <path d="M4.5 15v3a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
    </Glyph>
  );
}

function IconSun() {
  return (
    <Glyph size={14}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </Glyph>
  );
}

function IconMoon() {
  return (
    <Glyph size={14}>
      <path d="M20 14.3A8.5 8.5 0 0 1 9.7 4a8.5 8.5 0 1 0 10.3 10.3Z" />
    </Glyph>
  );
}

/** 跟随系统：显示器轮廓（与浅/深两态形成三态区分） */
function IconMonitor() {
  return (
    <Glyph size={14}>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20.5h6M12 16.5v4" />
    </Glyph>
  );
}

/* ── 档位表（值是契约，label 是文案） ───────────────────────── */

interface ChipOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  /** 只有主题三档带图标——参考实现里也只有它带，其余档位是纯数值/短词，加图标只会更吵 */
  readonly icon?: ReactNode;
}

const THEME_OPTIONS: readonly ChipOption<Theme>[] = [
  { value: "light", label: t.settingsDialog.themeLight, icon: <IconSun /> },
  { value: "dark", label: t.settingsDialog.themeDark, icon: <IconMoon /> },
  { value: "system", label: t.settingsDialog.themeSystem, icon: <IconMonitor /> },
];

/** 14–20 全档逐个列出（档位表在 store，见 FONT_SIZE_PRESETS 的注释） */
const FONT_SIZE_OPTIONS: readonly ChipOption<number>[] = FONT_SIZE_PRESETS.map((size) => ({
  value: size,
  label: t.settingsDialog.fontSizeValue(size),
}));

/** 与状态栏 zoom% 的档位菜单**同一张表**（ZOOM_PRESETS），两处不许各写一份 */
const ZOOM_OPTIONS: readonly ChipOption<number>[] = ZOOM_PRESETS.map((zoom) => ({
  value: zoom,
  label: t.settingsDialog.zoomValue(zoom),
}));

const READING_WIDTH_LABELS: Record<ReadingWidth, string> = {
  fluid: t.settingsDialog.readingWidthFluid,
  medium: t.settingsDialog.readingWidthMedium,
  wide: t.settingsDialog.readingWidthWide,
};

/** 顺序取自 store 的 READING_WIDTHS（迁移用的白名单与 UI 顺序共用一张表） */
const READING_WIDTH_OPTIONS: readonly ChipOption<ReadingWidth>[] = READING_WIDTHS.map(
  (width) => ({ value: width, label: READING_WIDTH_LABELS[width] }),
);

/**
 * codeWrap 是 boolean，但分段控件要的是可当 key 的字面量。
 * 不做成「开 / 关」两个字：两档各自的**后果**不同（折行会打乱缩进对齐，
 * 关掉是横向滚动），标签直接说后果比说开关状态有用。
 */
type CodeWrapValue = "wrap" | "scroll";

const CODE_WRAP_OPTIONS: readonly ChipOption<CodeWrapValue>[] = [
  { value: "wrap", label: t.settingsDialog.codeWrapOn },
  { value: "scroll", label: t.settingsDialog.codeWrapOff },
];

const FRONTMATTER_OPTIONS: readonly ChipOption<FrontmatterDisplay>[] = [
  { value: "card", label: t.settingsDialog.frontmatterCard },
  { value: "hidden", label: t.settingsDialog.frontmatterHidden },
  { value: "raw", label: t.settingsDialog.frontmatterRaw },
];

const HTML_EXPORT_OPTIONS: readonly ChipOption<ExportHtmlMode>[] = [
  { value: "single-file", label: t.settingsDialog.htmlSingleFile },
  { value: "with-assets", label: t.settingsDialog.htmlWithAssets },
];

/* ── 分区（导航项 = 图标 + 名称，内容区顶部一句分区说明） ────── */

type SectionId = "appearance" | "reading" | "export";

interface SectionMeta {
  readonly id: SectionId;
  readonly label: string;
  readonly description: string;
  readonly icon: ReactNode;
}

const SECTIONS: readonly SectionMeta[] = [
  {
    id: "appearance",
    label: t.settingsDialog.sectionAppearance,
    description: t.settingsDialog.sectionAppearanceDesc,
    icon: <IconContrast />,
  },
  {
    id: "reading",
    label: t.settingsDialog.sectionReading,
    description: t.settingsDialog.sectionReadingDesc,
    icon: <IconBook />,
  },
  {
    id: "export",
    label: t.settingsDialog.sectionExport,
    description: t.settingsDialog.sectionExportDesc,
    icon: <IconExport />,
  },
];

/* ── 布局零件 ───────────────────────────────────────────────── */

/**
 * 分段控件：bg-panel 的轨道 + bg-layer 的选中块（参考实现里「浅色/深色/跟随系统」那一组）。
 *
 * 用 button + aria-pressed 而非原生 input/select：原生控件带浏览器默认外观与聚焦环，
 * 和本项目"反馈只换背景色"的语言对不上；下拉式控件还要自带弹层、外点关闭与一套
 * 与本卡 Esc 抢语义的键盘处理——本卡最长的一组也只有七档（14–20 px），
 * 全部平铺出来既看得见全貌，一次点击就直达，不值得为它引入第二种控件形态。
 * 选中态靠"抬起一块"（换底色 + lv1 阴影）而不是描边：描边会让 hover 时出现两种高亮形状。
 */
function SegmentedGroup<T extends string | number>({
  label,
  value,
  options,
  onSelect,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly ChipOption<T>[];
  readonly onSelect: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center justify-end gap-0.5 rounded-row bg-panel p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              onSelect(option.value);
            }}
            className={`flex h-7 items-center gap-1.5 rounded-chip px-2.5 text-ui-sm ${
              active
                ? "bg-layer text-primary shadow-lv1"
                : "text-secondary hover:bg-hover"
            }`}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 一个设置项：左边「标签 + 一行短说明」，右边控件，行间一道 l1 细线。
 *
 * 说明是**必填**而不是可选：这些选项没有一个是"字面意思即全部"——折行会打乱缩进、
 * 单文件 HTML 体积会变大、字号与缩放看着像同一件事。只写名字等于把代价藏起来。
 * 但它只占一行：更长的解释属于分区说明（见文件头）。
 *
 * 行是 flex-wrap 的：窗口窄到控件挤不下时，控件整组换到下一行右对齐，
 * 而不是把标签压成竖排——只读查看器的设置卡宁可高一点，也不能糊成一团。
 */
function SettingRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-l1 py-3 last:border-b-0">
      {/* min-w 是**换行的开关**：标签块若允许无限收缩，flexbox 就永远不会换行，
          窗口一窄标签会被挤成一列竖字，控件却毫发无损——正好挤坏该保的那一半 */}
      <div className="min-w-[9rem] flex-1">
        <p className="text-ui text-primary">{label}</p>
        <p className="mt-0.5 text-ui-xs text-tertiary">{hint}</p>
      </div>
      <div className="ml-auto shrink-0">{children}</div>
    </div>
  );
}

/* ── 对话框本体 ─────────────────────────────────────────────── */

export function SettingsDialog({ onClose, onOpenLark }: SettingsDialogProps) {
  // 逐项订阅而不是整体取 state：整体取会在每次 set 后返回新对象，
  // 触发 React 18 的 getSnapshot 缓存告警，也会让无关字段的变更重渲染本卡。
  const theme = useSettingsStore((state) => state.theme);
  const fontSize = useSettingsStore((state) => state.fontSize);
  const zoomPercent = useSettingsStore((state) => state.zoomPercent);
  const readingWidth = useSettingsStore((state) => state.readingWidth);
  const codeWrap = useSettingsStore((state) => state.codeWrap);
  const frontmatterDisplay = useSettingsStore((state) => state.frontmatterDisplay);
  const htmlExportMode = useSettingsStore((state) => state.htmlExportMode);

  const setTheme = useSettingsStore((state) => state.setTheme);
  const setFontSize = useSettingsStore((state) => state.setFontSize);
  const setZoomPercent = useSettingsStore((state) => state.setZoomPercent);
  const setReadingWidth = useSettingsStore((state) => state.setReadingWidth);
  const setCodeWrap = useSettingsStore((state) => state.setCodeWrap);
  const setFrontmatterDisplay = useSettingsStore((state) => state.setFrontmatterDisplay);
  const setHtmlExportMode = useSettingsStore((state) => state.setHtmlExportMode);

  /**
   * 当前分区。刻意**不持久化**：设置页每次都从「外观」开始，
   * 记住上次停在哪反而让"打开设置看到的东西"变得不可预测，
   * 而这三个分区加起来也就八项，找起来不费事。
   */
  const [section, setSection] = useState<SectionId>("appearance");
  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];

  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /** 换分区时把内容区滚回顶部：新分区的第一项不该藏在上一分区留下的滚动位置底下 */
  const contentRef = useRef<HTMLDivElement | null>(null);

  /**
   * 打开即把焦点交给「关闭」钮：本卡没有主动作，Enter 的唯一合理语义就是"看完了，关掉"。
   * 焦点若落在第一个分区导航项上，Enter 会变成"重新选一次当前分区"——一个什么都不做的动作。
   */
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  /* ── 键盘：Esc + Tab 焦点陷阱（DG 6.5，与飞书设置卡同一套写法） ── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      // 捕获阶段一律吃掉：本卡是最上层，App 的 Esc 语义链不该同时响应
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-mask p-6 animate-fade-in"
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.settingsDialog.title}
        onKeyDown={onTrapKeyDown}
        // 卡内点击不该关窗
        onClick={(event) => event.stopPropagation()}
        // 固定高度：分区之间条目数不同，让卡片随之忽高忽低会把导航项在屏幕上挪位置。
        // overflow-hidden 是为了让左栏的 bg-panel 跟着卡片的圆角切边。
        className="flex h-[520px] max-h-[80vh] w-full max-w-[760px] overflow-hidden rounded-card border border-float bg-layer shadow-lv3"
      >
        {/* ── 左：分区导航（顶部是卡片标题，同参考实现） ── */}
        <nav
          aria-label={t.settingsDialog.nav}
          // 分栏线用 l2 而不是 l1：l1 是列表内条目之间的细线，两个**版块**之间
          // （同状态栏、分组头）一律 l2，否则浅色下 panel 与 layer 只差一档灰、看不出分栏
          className="flex w-[168px] shrink-0 flex-col gap-0.5 border-r border-l2 bg-panel p-2"
        >
          <p className="shrink-0 px-2 pb-2 pt-1 text-ui font-medium text-primary">
            {t.settingsDialog.title}
          </p>
          {SECTIONS.map((item) => {
            const active = item.id === current.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  setSection(item.id);
                }}
                className={`flex h-row w-full shrink-0 items-center gap-2 rounded-row px-2 text-left ${
                  active ? "bg-hover text-primary" : "text-secondary hover:bg-hover"
                }`}
              >
                <span className={active ? "text-primary" : "text-tertiary"}>
                  {item.icon}
                </span>
                <span className="truncate text-ui-sm">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* ── 右：当前分区的内容 + 底栏 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {/* 分区说明：承载跨行才说得清的话（见文件头），每行的短说明不重复它 */}
            <p className="text-ui-sm text-secondary">{current.description}</p>

            {current.id === "appearance" ? (
              <div className="mt-2">
                <SettingRow
                  label={t.settingsDialog.theme}
                  hint={t.settingsDialog.themeHint}
                >
                  <SegmentedGroup
                    label={t.settingsDialog.theme}
                    value={theme}
                    options={THEME_OPTIONS}
                    onSelect={setTheme}
                  />
                </SettingRow>

                {/* 字号与缩放刻意相邻：两者的分工写在本分区顶部的说明里，
                    不说清楚的话，用户会以为这两项是同一件事的两种写法，然后两边都调一遍 */}
                <SettingRow
                  label={t.settingsDialog.fontSize}
                  hint={t.settingsDialog.fontSizeHint}
                >
                  <SegmentedGroup
                    label={t.settingsDialog.fontSize}
                    value={fontSize}
                    options={FONT_SIZE_OPTIONS}
                    onSelect={setFontSize}
                  />
                </SettingRow>

                <SettingRow label={t.settingsDialog.zoom} hint={t.settingsDialog.zoomHint}>
                  <SegmentedGroup
                    label={t.settingsDialog.zoom}
                    value={zoomPercent}
                    options={ZOOM_OPTIONS}
                    onSelect={setZoomPercent}
                  />
                </SettingRow>
              </div>
            ) : null}

            {current.id === "reading" ? (
              <div className="mt-2">
                <SettingRow
                  label={t.settingsDialog.readingWidth}
                  hint={t.settingsDialog.readingWidthHint}
                >
                  <SegmentedGroup
                    label={t.settingsDialog.readingWidth}
                    value={readingWidth}
                    options={READING_WIDTH_OPTIONS}
                    onSelect={setReadingWidth}
                  />
                </SettingRow>

                <SettingRow
                  label={t.settingsDialog.codeWrap}
                  hint={t.settingsDialog.codeWrapHint}
                >
                  <SegmentedGroup
                    label={t.settingsDialog.codeWrap}
                    value={codeWrap ? "wrap" : "scroll"}
                    options={CODE_WRAP_OPTIONS}
                    onSelect={(value) => {
                      setCodeWrap(value === "wrap");
                    }}
                  />
                </SettingRow>

                <SettingRow
                  label={t.settingsDialog.frontmatter}
                  hint={t.settingsDialog.frontmatterHint}
                >
                  <SegmentedGroup
                    label={t.settingsDialog.frontmatter}
                    value={frontmatterDisplay}
                    options={FRONTMATTER_OPTIONS}
                    onSelect={setFrontmatterDisplay}
                  />
                </SettingRow>
              </div>
            ) : null}

            {current.id === "export" ? (
              <div className="mt-2">
                {/* 与导出对话框读写**同一个** store 字段：在哪边改都一样，不存在两份偏好 */}
                <SettingRow
                  label={t.settingsDialog.htmlExport}
                  hint={t.settingsDialog.htmlExportHint}
                >
                  <SegmentedGroup
                    label={t.settingsDialog.htmlExport}
                    value={htmlExportMode}
                    options={HTML_EXPORT_OPTIONS}
                    onSelect={setHtmlExportMode}
                  />
                </SettingRow>

                {/* 飞书凭据：只给入口，表单仍在 LarkSettingsDialog（见文件头注释） */}
                <SettingRow label={t.settingsDialog.lark} hint={t.settingsDialog.larkHint}>
                  <button
                    type="button"
                    onClick={onOpenLark}
                    className="flex h-row items-center rounded-row px-2.5 text-ui-sm text-primary hover:bg-hover"
                  >
                    {t.settingsDialog.larkOpen}
                  </button>
                </SettingRow>
              </div>
            ) : null}
          </div>

          {/* 底栏：左边那行淡字说明"为什么没有确定/取消"，右边只有关闭 */}
          <div className="flex shrink-0 items-center justify-between gap-4 border-t border-l2 px-5 py-3">
            <p className="min-w-0 truncate text-ui-xs text-tertiary">
              {t.settingsDialog.autoSaveHint}
            </p>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="flex h-btn shrink-0 items-center rounded-btn bg-brand px-3.5 text-ui font-medium text-inverted hover:bg-brand-hover"
            >
              {t.common.close}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
