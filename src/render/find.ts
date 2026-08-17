/**
 * 文档内查找的核心逻辑 —— UPGRADE_PLAN 3.1（blocker）。
 *
 * 【为什么命中标记必须走 CSS Custom Highlight API】
 * 传统做法是把命中处包一层 `<mark>`。本项目**不能**这么做，三条硬理由：
 *   1. Mermaid 的 SVG 与 KaTeX 的 span 树是渲染器自己维护的，插节点会让它们的
 *      测量/重绘错乱，甚至下一次 rerender 直接崩；
 *   2. 正文是 DOMPurify 之后的成品结构，插了再撤会让结构逐次漂移（尤其是撤销时
 *      normalize 合并文本节点，滚动锚点与大纲的 id 会跟着抖）；
 *   3. 改 DOM 会触发一轮完整的样式与布局重算——10MB 语料下每敲一个键卡半秒。
 * Highlight API 只登记 Range，**一个 DOM 节点都不动**，重绘代价只有绘制层。
 * WebView2 基于 Chromium 105+ 一律支持（DG 8 的运行环境下限）。
 *
 * 【样式在哪】本模块只负责 `CSS.highlights.set(...)`，两条 `::highlight()` 规则
 * 必须由样式层提供（见文件末尾 FIND_HIGHLIGHT / FIND_ACTIVE_HIGHLIGHT 的注释），
 * 组件内联 <style> 一律不写。
 *
 * 【与 App 的边界】本模块不认识 React、不认识 store，只吃两个容器元素：
 *   content —— 正文容器（App 的 contentRef，即 .md-content）：文本索引的根
 *   scroller —— 阅读区滚动容器（App 的 scrollerRef，即 [data-reading-root]）：跳转时滚它
 * 状态（当前第几处 / 共几处）由调用方（stores/uiState.ts）持有，本模块只保留
 * 「索引 + 命中偏移表 + 已登记的高亮」这些无法放进 store 的重资源。
 *
 * 【性能契约】10MB 语料下输入不卡：
 *   - 文本索引只建一次，缓存到文档变化为止（invalidateFindIndex / 内部 MutationObserver）；
 *   - 索引构建切片进行（每 8ms 让出主线程），构建期间界面照常响应，浮条显示「正在索引…」；
 *   - 匹配是一次 indexOf 扫描（原生），命中数封顶 MATCH_LIMIT；
 *   - Range 只对前 HIGHLIGHT_LIMIT 处物化（再多也看不过来），当前命中按需单独物化。
 */

/* ── 高亮名（样式层的 ::highlight() 必须用同名） ────────────────── */

/** 全部命中的底色 */
export const FIND_HIGHLIGHT = "md-find";
/** 当前命中（n/m 里的 n）的底色，优先级高于 FIND_HIGHLIGHT */
export const FIND_ACTIVE_HIGHLIGHT = "md-find-active";

/* ── 常量（技术值，不是文案） ───────────────────────────────────── */

/**
 * 命中总数上限。超过后计数显示 `m+`（i18n 的 countTruncated），跳转仍在前 m 处循环。
 * 取 20000 与 VS Code 同量级：再多的命中对"找东西"这件事已经没有信息量，
 * 而无上限会让 10MB 语料里搜"的"直接把内存打满。
 */
const MATCH_LIMIT = 20000;
/**
 * 真正登记进 md-find 高亮的命中数上限。
 * Range 物化是本流程唯一的线性大开销（20000 个约 60ms，会被看见），
 * 而一屏最多也就几十处；超出部分不画底色，但计数与跳转不受影响。
 */
const HIGHLIGHT_LIMIT = 5000;

/** 索引构建的时间片：每片最多占用主线程这么久，超了就让出一帧 */
const BUILD_SLICE_MS = 8;
/** 每处理这么多文本节点检查一次时间片（取 2 的幂，取模开销可忽略） */
const BUILD_CHECK_EVERY = 512;

/**
 * 命中已在视口内、且离上下边缘还有这么多像素时**不滚动**。
 * 输入时每敲一个键都把画面重新居中会晃得没法看；只有命中真的跑出视野才动。
 */
const KEEP_IN_VIEW_MARGIN = 48;

/** 当前命中的 400ms 脉冲：这一刻熄、这一刻再亮（合计一次明暗切换） */
const PULSE_OFF_MS = 160;
const PULSE_ON_MS = 320;

/**
 * 块级边界的填充字符。
 *
 * 全文被拼成一条长字符串做子串匹配，相邻两个块（两个 <p>）的文字若直接首尾相连，
 * 「上一段结尾 + 下一段开头」会拼出一个正文里根本不存在的词。塞一个 NUL 把它们隔开：
 * NUL 不可能出现在用户的查询里（输入框打不出来），也不可能出现在 Markdown 正文里。
 * 它在字符串里占 1 个位置且不属于任何文本节点，但匹配永远不会跨过它，
 * 所以「偏移 → 节点」的映射不受影响（见 locateNode 的注释）。
 */
const BLOCK_SEPARATOR = "\u0000";

/** 整棵子树都不参与查找的元素：脚本/样式、图表 SVG、离屏舞台、渲染层注入的 UI */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEXTAREA",
  "IFRAME",
  "CANVAS",
  "OBJECT",
  "TEMPLATE",
  // Mermaid 产物：SVG 里的 <text> 不受 ::highlight() 影响，索引了也标不出来，
  // 只会让计数比肉眼看到的多，索性整棵跳过
  "SVG",
  // KaTeX 的 MathML 分支是视觉隐藏的无障碍副本（可见的是 .katex-html），
  // 不跳过会让每个公式的命中数翻倍
  "MATH",
]);

/**
 * 行内元素白名单：用于判断两个文本节点是否属于同一个块。
 * 只列 Markdown 渲染产物里真的会出现的那些，宁可漏判（多插一个分隔符）
 * 也不误判（把两个块当成一个块，拼出幻影命中）。
 */
const INLINE_TAGS = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "BIG",
  "CITE",
  "CODE",
  "DEL",
  "EM",
  "I",
  "INS",
  "KBD",
  "MARK",
  "Q",
  "RP",
  "RT",
  "RUBY",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "U",
  "VAR",
  "WBR",
]);

/** 全角 ASCII（U+FF01–U+FF5E）与表意空格：折成半角后再比，"ＡＢＣ" 能被 "abc" 搜到 */
const FULLWIDTH_RE = /[\uFF01-\uFF5E\u3000]/;
const FULLWIDTH_OFFSET = 0xfee0;

/* ── 模块内状态 ─────────────────────────────────────────────────── */

/** 全文索引：一条长字符串 + 「第 i 个文本节点从哪个偏移开始」 */
interface TextIndex {
  readonly nodes: readonly Text[];
  /** 长度 = nodes.length + 1，末位是 haystack 总长（二分时当哨兵用） */
  readonly starts: readonly number[];
  /** 归一化（小写 + 全角折半）后的全文，与各节点原文**逐字符等长** */
  readonly haystack: string;
}

let contentRoot: HTMLElement | null = null;
let scrollRoot: HTMLElement | null = null;

let textIndex: TextIndex | null = null;
let building: Promise<TextIndex | null> | null = null;
/** 索引世代：invalidate 一次自增一次，构建中的旧索引据此作废 */
let indexToken = 0;
/** 查询世代：每次 runFindQuery 自增，异步回来时对不上就丢弃 */
let searchToken = 0;

/** 命中在 haystack 中的起始偏移（文档序） */
let matchOffsets: number[] = [];
/** 归一化后的关键词长度 = 每处命中在 haystack 中占的字符数 */
let matchLength = 0;
let matchTruncated = false;
/** 已物化的 Range（与 matchOffsets 同下标），按需填充 */
let rangeCache: (Range | null)[] = [];

let mutationObserver: MutationObserver | null = null;
const invalidateListeners = new Set<() => void>();
let pulseTimers: number[] = [];

/* ── 环境能力 ───────────────────────────────────────────────────── */

let unsupportedWarned = false;

/** 运行环境是否支持 CSS Custom Highlight API（WebView2 = Chromium 105+ 恒为真） */
export function isFindSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight === "function"
  );
}

/**
 * 取高亮注册表。不支持时返回 null 并只警告一次——
 * 此时查找依然可用（计数与跳转都对），只是没有底色，属于诚实降级而不是崩掉。
 */
function registry(): HighlightRegistry | null {
  if (!isFindSupported()) {
    if (!unsupportedWarned) {
      unsupportedWarned = true;
      console.warn("[find] CSS Custom Highlight API unavailable, running without marks");
    }
    return null;
  }
  return CSS.highlights;
}

/* ── 归一化：小写 + 全角折半，且**逐字符等长** ──────────────────── */

/**
 * 等长是硬要求：haystack 的下标要直接换算成文本节点内的下标，
 * 一旦某个字符折叠后长度变了（如 'İ'.toLowerCase() 长度为 2），后面所有命中都会错位。
 * 所以慢路径里只接受"折叠结果仍是单字符"的映射，否则原样保留。
 */
function foldText(text: string): string {
  const lower = text.toLowerCase();
  // 快路径：绝大多数中文/已小写的英文在这里就返回（toLowerCase 是原生实现，很快）
  if (lower.length === text.length && !FULLWIDTH_RE.test(lower)) {
    return lower;
  }

  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    let char = text.charAt(index);
    if (code >= 0xff01 && code <= 0xff5e) {
      char = String.fromCharCode(code - FULLWIDTH_OFFSET);
    } else if (code === 0x3000) {
      char = " ";
    }
    const folded = char.toLowerCase();
    out += folded.length === 1 ? folded : char;
  }
  return out;
}

/* ── 文本索引 ───────────────────────────────────────────────────── */

function shouldSkipElement(element: Element): boolean {
  if (SKIP_TAGS.has(element.tagName.toUpperCase())) {
    return true;
  }
  if (element.hasAttribute("hidden")) {
    return true;
  }
  // 渲染层的离屏双缓冲舞台（正常挂在 body 上，这里是纵深防御）
  if (element.hasAttribute("data-render-stage")) {
    return true;
  }
  // 外链图片占位块：是 UI 不是正文（与「拖选正文粘出 python 复制」同一类问题）
  if (element.hasAttribute("data-external-image")) {
    return true;
  }
  // 代码块工具条：[data-code-block] 包裹层下唯一的 div（另一个子节点是 pre）
  if (
    element.tagName === "DIV" &&
    element.parentElement?.hasAttribute("data-code-block") === true
  ) {
    return true;
  }
  const classes = element.classList;
  // 标题右侧的 ¶ 锚点链接；KaTeX 的 MathML 副本（另有 MATH 标签兜底）
  if (classes.contains("vditor-anchor") || classes.contains("katex-mathml")) {
    return true;
  }
  return false;
}

/** 文本节点所属的块元素：向上跳过所有行内元素，用于判断要不要插分隔符 */
function blockAncestorOf(node: Text, root: HTMLElement): Element | null {
  let current = node.parentElement;
  while (current !== null && current !== root && INLINE_TAGS.has(current.tagName)) {
    current = current.parentElement;
  }
  return current;
}

function nextTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

/**
 * 切片式收集文本节点。返回 null 表示构建期间索引已被作废（文档换了/重渲染了），
 * 调用方直接丢弃即可。
 */
async function buildIndex(root: HTMLElement, token: number): Promise<TextIndex | null> {
  const nodes: Text[] = [];
  const starts: number[] = [];
  const pieces: string[] = [];
  let total = 0;
  let seen = 0;
  let sliceStart = performance.now();

  let previousBlock: Element | null = null;
  // 同一个 parentElement 连续出现是常态（一段话里的多个文本节点），memo 一格就够
  let memoParent: Element | null = null;
  let memoBlock: Element | null = null;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node: Node): number => {
        if (node instanceof Element) {
          // REJECT 整棵子树跳过，SKIP 只跳过元素自身、继续往下走
          return shouldSkipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return node instanceof Text && node.data.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );

  while (walker.nextNode() !== null) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) {
      continue;
    }

    const parent = node.parentElement;
    if (parent !== memoParent) {
      memoParent = parent;
      memoBlock = blockAncestorOf(node, root);
    }
    if (previousBlock !== null && memoBlock !== previousBlock) {
      pieces.push(BLOCK_SEPARATOR);
      total += BLOCK_SEPARATOR.length;
    }
    previousBlock = memoBlock;

    nodes.push(node);
    starts.push(total);
    const folded = foldText(node.data);
    pieces.push(folded);
    total += folded.length;

    seen += 1;
    if (seen % BUILD_CHECK_EVERY === 0 && performance.now() - sliceStart > BUILD_SLICE_MS) {
      await nextTask();
      if (token !== indexToken) {
        return null;
      }
      sliceStart = performance.now();
    }
  }

  starts.push(total);
  return { nodes, starts, haystack: pieces.join("") };
}

async function ensureIndex(): Promise<TextIndex | null> {
  if (textIndex !== null) {
    return textIndex;
  }
  if (building !== null) {
    return building;
  }
  const root = contentRoot;
  if (root === null) {
    return null;
  }

  const token = indexToken;
  building = buildIndex(root, token).then((built) => {
    building = null;
    if (token !== indexToken || built === null) {
      return null;
    }
    textIndex = built;
    observeMutations(root);
    return built;
  });
  return building;
}

/** 索引是否已就绪（浮条据此决定要不要显示「正在索引…」） */
export function isFindIndexReady(): boolean {
  return textIndex !== null;
}

/* ── 偏移 → Range ───────────────────────────────────────────────── */

/**
 * 二分：找最大的 i 使 starts[i] <= offset。
 *
 * 块分隔符占据的偏移不属于任何节点，落在那里会返回"分隔符前一个节点"且
 * 节点内偏移等于该节点长度——那是合法的 Range 边界，不会抛。
 * 而匹配永远不会覆盖分隔符（关键词里不可能有 NUL），所以实际取不到这种情况。
 */
function locateNode(index: TextIndex, offset: number): number {
  let low = 0;
  let high = index.nodes.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (index.starts[mid] <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function createRange(index: TextIndex, start: number, length: number): Range | null {
  const end = start + length;
  const startIndex = locateNode(index, start);
  const endIndex = locateNode(index, end - 1);
  if (startIndex >= index.nodes.length || endIndex >= index.nodes.length) {
    return null;
  }
  const startNode = index.nodes[startIndex];
  const endNode = index.nodes[endIndex];
  try {
    const range = document.createRange();
    range.setStart(startNode, start - index.starts[startIndex]);
    range.setEnd(endNode, end - index.starts[endIndex]);
    return range;
  } catch (error: unknown) {
    // 理论上不会发生（偏移都在节点长度内），但 DOM 被外力改过时宁可少一处命中也不崩
    console.warn("[find] range creation failed", error);
    return null;
  }
}

/** 取第 i 处命中的 Range（0-based），按需物化并缓存 */
function rangeAt(position: number): Range | null {
  if (position < 0 || position >= matchOffsets.length) {
    return null;
  }
  // rangeCache 与 matchOffsets 等长且初值全为 null，越界已在上一步挡掉
  const cached = rangeCache[position];
  if (cached !== null) {
    return cached;
  }
  const index = textIndex;
  if (index === null) {
    return null;
  }
  const range = createRange(index, matchOffsets[position], matchLength);
  rangeCache[position] = range;
  return range;
}

/* ── 高亮登记 ───────────────────────────────────────────────────── */

function paintMatches(): void {
  const store = registry();
  if (store === null) {
    return;
  }
  if (matchOffsets.length === 0) {
    store.delete(FIND_HIGHLIGHT);
    return;
  }
  const highlight = new Highlight();
  const painted = Math.min(matchOffsets.length, HIGHLIGHT_LIMIT);
  for (let position = 0; position < painted; position += 1) {
    const range = rangeAt(position);
    if (range !== null) {
      highlight.add(range);
    }
  }
  store.set(FIND_HIGHLIGHT, highlight);
}

function paintActive(range: Range | null): void {
  const store = registry();
  if (store === null) {
    return;
  }
  if (range === null) {
    store.delete(FIND_ACTIVE_HIGHLIGHT);
    return;
  }
  const highlight = new Highlight();
  highlight.add(range);
  // 与 md-find 同时命中同一段文字时必须画在上面（同优先级时按登记顺序，不够确定）
  highlight.priority = 1;
  store.set(FIND_ACTIVE_HIGHLIGHT, highlight);
}

function clearPulse(): void {
  for (const timer of pulseTimers) {
    window.clearTimeout(timer);
  }
  pulseTimers = [];
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 当前命中的 400ms 脉冲：熄一下再亮回来。
 *
 * 用 active 高亮的登记/注销实现，**不碰 DOM**（不加 class、不插节点）。
 * 熄灭期间那一处仍有 md-find 的普通底色，所以看起来是"闪了一下"而不是"消失了"。
 * ::highlight() 的属性在 Chromium 里不参与 transition/animation，
 * 淡入淡出做不了，切换是唯一的表达方式。
 */
function schedulePulse(range: Range): void {
  clearPulse();
  if (prefersReducedMotion()) {
    return;
  }
  pulseTimers.push(
    window.setTimeout(() => {
      paintActive(null);
    }, PULSE_OFF_MS),
  );
  pulseTimers.push(
    window.setTimeout(() => {
      paintActive(range);
    }, PULSE_ON_MS),
  );
}

/* ── 滚动 ───────────────────────────────────────────────────────── */

/**
 * 把命中滚进视口，纵向居中（block:"center"）。
 *
 * **不做平滑滚动**：军规 1 规定阅读区唯一允许的滚动动画是大纲跳转的 250ms，
 * 查找跳转必须是瞬时的（连按 Enter 时平滑滚动会互相追尾，反而看不清跳到哪了）。
 * 命中已经舒适地在视野里就完全不滚——输入时每敲一键都重新居中会晃得没法读。
 */
function scrollRangeIntoView(range: Range): void {
  const scroller = scrollRoot;
  if (scroller === null) {
    return;
  }
  const rect = range.getBoundingClientRect();
  // 折行/跨节点的 Range 可能量到零尺寸（极少数情况），此时不滚比乱滚好
  if (rect.height === 0 && rect.width === 0) {
    return;
  }
  const viewport = scroller.getBoundingClientRect();
  const offsetTop = rect.top - viewport.top;
  const inView =
    offsetTop >= KEEP_IN_VIEW_MARGIN &&
    offsetTop + rect.height <= viewport.height - KEEP_IN_VIEW_MARGIN;
  if (inView) {
    return;
  }
  const target = scroller.scrollTop + offsetTop - (viewport.height - rect.height) / 2;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.min(Math.max(0, target), max);
}

/* ── 文档变化：自动作废 ─────────────────────────────────────────── */

function disconnectObserver(): void {
  mutationObserver?.disconnect();
  mutationObserver = null;
}

/**
 * 只在"索引已建好"期间监听，索引一作废就断开——平时零开销。
 * 静默刷新（外部保存）走的是 replaceChildren，一次 childList 变更即可命中；
 * 图片点击加载、代码块复制反馈这类局部改动同样会命中，宁可多重建一次也不给错计数。
 */
function observeMutations(root: HTMLElement): void {
  disconnectObserver();
  if (typeof MutationObserver !== "function") {
    return;
  }
  mutationObserver = new MutationObserver(() => {
    invalidateFindIndex();
  });
  mutationObserver.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/* ── 对外接口 ───────────────────────────────────────────────────── */

/**
 * 绑定阅读区容器。两个都传 null 表示解绑（同时清掉高亮与索引）。
 * @param content  正文容器（.md-content）：文本索引的根
 * @param scroller 滚动容器（[data-reading-root]）：跳转时滚它
 */
export function setFindRoot(
  content: HTMLElement | null,
  scroller: HTMLElement | null,
): void {
  if (content === contentRoot && scroller === scrollRoot) {
    return;
  }
  contentRoot = content;
  scrollRoot = scroller;
  invalidateFindIndex();
}

/** 订阅"索引已作废"（文档重渲染）。返回退订函数。 */
export function onFindIndexInvalidated(listener: () => void): () => void {
  invalidateListeners.add(listener);
  return () => {
    invalidateListeners.delete(listener);
  };
}

/** 清掉命中与全部高亮（关闭查找条 / 清空关键词时调用） */
export function clearFindHighlights(): void {
  clearPulse();
  matchOffsets = [];
  rangeCache = [];
  matchLength = 0;
  matchTruncated = false;
  const store = registry();
  if (store !== null) {
    store.delete(FIND_HIGHLIGHT);
    store.delete(FIND_ACTIVE_HIGHLIGHT);
  }
}

/**
 * 丢弃文本索引与全部命中。**文档重渲染后必须调用**（主控在渲染 settled 后接线）。
 * 模块内的 MutationObserver 也会自动触发这条路径，两者互为兜底。
 */
export function invalidateFindIndex(): void {
  indexToken += 1;
  textIndex = null;
  building = null;
  disconnectObserver();
  clearFindHighlights();
  for (const listener of invalidateListeners) {
    listener();
  }
}

export interface FindOutcome {
  /** 命中总数（封顶 MATCH_LIMIT） */
  readonly total: number;
  /** 命中数触顶：计数应显示 `m+` */
  readonly truncated: boolean;
  /** 本次结果已被更新的查询取代，调用方必须整批丢弃 */
  readonly stale: boolean;
}

const EMPTY_OUTCOME: FindOutcome = { total: 0, truncated: false, stale: false };
const STALE_OUTCOME: FindOutcome = { total: 0, truncated: false, stale: true };

/**
 * 执行查找并刷新命中高亮。**不跳转、不滚动**（跳转由 activateFindMatch 单独负责）。
 *
 * 异步的唯一原因是索引可能要现建（大文档切片进行）；索引已就绪时这个 Promise
 * 会在同一个微任务里 resolve，不引入额外延迟。
 */
export async function runFindQuery(query: string): Promise<FindOutcome> {
  const token = (searchToken += 1);
  // 输入框打不出换行，但粘贴可能带进来；折成空格而不是丢弃，避免把两个词粘成一个
  const needle = foldText(query.replace(/[\r\n\t]+/g, " "));
  if (needle === "" || contentRoot === null) {
    clearFindHighlights();
    return EMPTY_OUTCOME;
  }

  const index = await ensureIndex();
  if (token !== searchToken) {
    return STALE_OUTCOME;
  }
  if (index === null) {
    clearFindHighlights();
    return EMPTY_OUTCOME;
  }

  const offsets: number[] = [];
  let truncated = false;
  let from = 0;
  for (;;) {
    const at = index.haystack.indexOf(needle, from);
    if (at < 0) {
      break;
    }
    offsets.push(at);
    // 命中不重叠（与 VS Code 同口径："aa" 在 "aaa" 里是 1 处不是 2 处）
    from = at + needle.length;
    if (offsets.length >= MATCH_LIMIT) {
      truncated = true;
      break;
    }
  }

  clearPulse();
  matchOffsets = offsets;
  matchLength = needle.length;
  matchTruncated = truncated;
  rangeCache = new Array<Range | null>(offsets.length).fill(null);
  paintMatches();
  paintActive(null);

  return { total: offsets.length, truncated, stale: false };
}

/** 当前命中总数（供 store 之外的旁路读取，如状态栏） */
export function getFindTotal(): number {
  return matchOffsets.length;
}

/** 当前命中数是否触顶 */
export function isFindTruncated(): boolean {
  return matchTruncated;
}

export interface ActivateOptions {
  /** 是否给 400ms 高亮脉冲（显式跳转给，输入过程中的自动定位不给） */
  readonly pulse?: boolean;
}

/**
 * 把第 index 处（**1-based**，与界面 n/m 一致）设为当前命中：
 * 登记 active 高亮 + 滚进视口（必要时）+ 可选脉冲。越界返回 false。
 */
export function activateFindMatch(index: number, options: ActivateOptions = {}): boolean {
  const position = index - 1;
  const range = rangeAt(position);
  if (range === null) {
    return false;
  }
  clearPulse();
  paintActive(range);
  scrollRangeIntoView(range);
  if (options.pulse === true) {
    schedulePulse(range);
  }
  return true;
}

/**
 * 视口里（或视口之后）的第一处命中，1-based；一处都没有返回 0，
 * 视口之后没有了则回到第 1 处（循环语义与 findNext 一致）。
 *
 * 命中按文档序排列、纵向位置基本单调，故用二分：只量 log2(n) 次矩形，
 * 20000 处命中也只有 15 次 getBoundingClientRect，不会成为输入时的卡点。
 */
export function nearestFindMatch(): number {
  if (matchOffsets.length === 0) {
    return 0;
  }
  const scroller = scrollRoot;
  if (scroller === null) {
    return 1;
  }
  const viewportTop = scroller.getBoundingClientRect().top;

  let low = 0;
  let high = matchOffsets.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = rangeAt(mid);
    if (range === null) {
      low = mid + 1;
      continue;
    }
    if (range.getBoundingClientRect().top - viewportTop >= 0) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found >= 0 ? found + 1 : 1;
}
