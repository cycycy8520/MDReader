/**
 * 长图模板 —— FR-10「分享到微信（长图）」的前端半。
 *
 * 【它与 printTemplate.ts 的关系】
 * 隐藏渲染窗口是同一扇（Rust 侧 `capture.rs` 复用 `export.rs` 的 `print` label 与
 * `__MDNAONAO_PRINT_JOB__` 注入契约），渲染管线也是同一条（`preview.ts` 的
 * `renderMarkdown`，「预览 = 导出」是立身之本）。本模块只在 printTemplate 的产物上
 * 补三件长图特有的事：
 *
 *   1. **版式宽度换成微信的 720px**（由 Rust 注入的 `imageWidth` 决定，不写死）；
 *   2. **四周留白 + 加大字号**：纸张有页边距，屏幕截图没有，不留白文字就贴着图边；
 *   3. **藏掉滚动条**：隐藏窗口照样会画滚动条，它会占掉 15px 版面宽并被一起截进图里。
 *
 * 因此这里刻意复用 `buildPrintDocument` / `mountPrintDocument`，而不是另起一条渲染路径——
 * 多一条路径就意味着 Mermaid / KaTeX / 告警块 / 代码高亮 / 图片改写各有两份实现。
 *
 * 【为什么不加页眉页脚、不加水印】
 * 用户没有要求。分享出去的图上挂应用名等于替用户署名，那是产品决策不是实现细节。
 * 需要时再由人类拍板加。
 *
 * 【拼接（超长文档）】
 * GPU 纹理上限约 16384px，超限由 Rust 分段截图。把 N 段拼成一张的活落在本模块的
 * [`composeSegments`]：CDP 只回 **已编码的 PNG**，Rust 侧拼接必须先自写 inflate 解码器，
 * 而渲染窗口本身就是 Chromium —— `createImageBitmap` + `<canvas>` 的解码与编码都是原生实现，
 * 零依赖。契约上它吃的正是 `capture_long_image({ output: null })` 回传的
 * `pngBase64`（顺序即从上到下的拼接顺序）。
 */

import { emitPrintReady, readMarkdown } from "../services/ipc";
import {
  buildPrintDocument,
  mountPrintDocument,
  PRINT_ERROR_ATTR,
  PRINT_JOB_GLOBAL,
  PRINT_READY_ATTR,
} from "./printTemplate";

/* ── 前后端契约 ─────────────────────────────────────────────── */

/**
 * 注入任务里的 `mode` 值。
 * **必须与 src-tauri/src/capture.rs 的 `CAPTURE_JOB_MODE` 逐字一致**，改一侧即改两侧。
 */
export const LONG_IMAGE_MODE = "image";

/** Rust `capture.rs::CaptureJob` 注入的长图任务（字段名 serde camelCase） */
export interface LongImageJob {
  /** 待渲染的 Markdown 文档绝对路径 */
  source: string;
  /** 版式宽度（CSS px），微信默认 720 */
  imageWidth: number;
}

/* ── 版式常量 ───────────────────────────────────────────────── */

/**
 * 版式宽度的兜底与边界。Rust 侧已经夹过一次（`MIN_IMAGE_WIDTH_PX`..`MAX_IMAGE_WIDTH_PX`），
 * 这里再夹一次是因为注入体理论上可信但不校验就会静默拿到 NaN：
 * `width: NaN` 的 body 会塌成 0，截出来是一张空图，而且没有任何报错。
 */
const DEFAULT_IMAGE_WIDTH_PX = 720;
const MIN_IMAGE_WIDTH_PX = 320;
const MAX_IMAGE_WIDTH_PX = 2048;

/**
 * 左右留白（CSS px）。720px 版式下正文净宽 672px，与公众号正文观感一致。
 * 纸张的留白由打印设置的页边距给（export.rs 的 `PDF_MARGIN_IN`），
 * 截图没有那一层，必须自己留，否则文字直接贴着图片边缘。
 */
const IMAGE_PADDING_X_PX = 24;

/** 上下留白（CSS px）。比左右稍大：首尾贴边比两侧贴边更刺眼。 */
const IMAGE_PADDING_Y_PX = 28;

/**
 * 长图正文字号（px），比打印的 15px 略大。
 *
 * 720px 宽的图发进聊天窗口会被缩到手机屏宽显示，15px 换算到屏上约 8pt，
 * 不点开看不清；16px 是 720px 版式下的通行取值（正文每行约 42 个汉字）。
 * 与阅读区的 `settings.fontSize` **不联动**：分享出去的图必须版式可复现，
 * 不能因为这台机器的人把字调大了就换一套断行。
 */
const LONG_IMAGE_FONT_PX = 16;

/** 装载后等字体的上限（KaTeX 字体是按需触发的，内联样式表后会重新解析一次） */
const FONT_SETTLE_TIMEOUT_MS = 3000;

/**
 * 等图片解码的上限。
 *
 * 与 PDF 那条链的区别：PDF 印的是文档流，图没加载完最多缺一张；
 * 长图是**像素快照**，没解码完的 `<img>` 在截图里就是一块空白，
 * 而且事后完全看不出「这里原本有图」。所以宁可多等。
 */
const IMAGE_SETTLE_TIMEOUT_MS = 15000;

/* ── canvas 合成的硬限制（Chromium） ────────────────────────── */

/** 单边上限：超过即 canvas 创建失败（表现为 toBlob 返回 null） */
const MAX_CANVAS_SIDE_PX = 65535;

/** 面积上限 16384²：宽 720 时约合 372,827px 高 */
const MAX_CANVAS_AREA_PX = 268435456;

/* ── 1. 读取注入的长图任务 ─────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 读取并校验长图任务；**只有** `mode === "image"` 才返回非 null。
 *
 * 这样 main.tsx 的分流不必改 printTemplate 的 `PrintMode` 联合类型：
 * ```ts
 * const imageJob = readLongImageJob();
 * if (imageJob !== null) { void renderLongImagePage(imageJob); }
 * else { const printJob = readPrintJob(); ... }
 * ```
 * 顺序不能反：`readPrintJob` 会把认不出的 mode 兜底成 `"pdf"`，先问它就永远轮不到长图。
 */
export function readLongImageJob(): LongImageJob | null {
  const raw: unknown = window[PRINT_JOB_GLOBAL];
  if (!isRecord(raw) || raw.mode !== LONG_IMAGE_MODE) {
    return null;
  }
  const source: unknown = raw.source;
  if (typeof source !== "string" || source === "") {
    console.warn("[long-image] capture job injected without a usable source path", raw);
    return null;
  }
  const injectedWidth: unknown = raw.imageWidth;
  const imageWidth =
    typeof injectedWidth === "number" && Number.isFinite(injectedWidth)
      ? Math.round(Math.min(Math.max(injectedWidth, MIN_IMAGE_WIDTH_PX), MAX_IMAGE_WIDTH_PX))
      : DEFAULT_IMAGE_WIDTH_PX;

  return { source, imageWidth };
}

/* ── 2. 长图专用增量样式 ───────────────────────────────────── */

/**
 * 排在 `buildPrintDocument` 内联的全部样式之后（靠源顺序压过它们）。
 *
 * 【滚动条那条为什么不写 `overflow-x: hidden`】
 * printTemplate 的覆盖层写了 `html, body { overflow: visible !important }`。
 * 一旦把 overflow-x 改成 hidden，CSS 规定 overflow-y 的 visible 会被计算成 auto，
 * 于是**必定**出现纵向滚动条——正好是我们要消灭的东西。所以只用伪元素把滚动条
 * 的尺寸压成 0（它同时不再占据版面宽度），overflow 一个字都不动。
 */
function buildLongImageCss(imageWidth: number): string {
  return `
/* ── 滚动条：隐藏窗口照样会画它，占 15px 版面宽并被一起截进图里 ── */
html { scrollbar-width: none; }
html::-webkit-scrollbar,
body::-webkit-scrollbar { width: 0 !important; height: 0 !important; }

/* ── 画布：宽度即版式宽度，四周留白 ── */
html, body {
  width: ${imageWidth}px;
  min-width: ${imageWidth}px;
  max-width: ${imageWidth}px;
}
body.md-print-body {
  box-sizing: border-box;
  padding: ${IMAGE_PADDING_Y_PX}px ${IMAGE_PADDING_X_PX}px;
  /* 长图恒用浅色（与打印同源理由）：底色写死白，不依赖 Token */
  background: #ffffff;
}

/* ── 正文：字号略大于打印，宽度撑满留白之内 ── */
.md-print-root {
  width: 100%;
  max-width: 100%;
  --md-reading-font: ${LONG_IMAGE_FONT_PX}px;
  --md-zoom: 1;
}

/* 长图不分页，纸面那套「整块不拆」的规则本就只在 @media print 生效，无需处理。
   这里只把最后一个块的下边距收掉，免得图底多出一段空白。 */
.md-print-root > *:last-child { margin-bottom: 0 !important; }
`;
}

/** 把长图增量样式追加到 head 末尾（必须在 mountPrintDocument 之后调用） */
function applyLongImageCss(imageWidth: number): void {
  const style = document.createElement("style");
  style.setAttribute("data-long-image", "true");
  style.textContent = buildLongImageCss(imageWidth);
  document.head.appendChild(style);
}

/* ── 3. 就绪等待 ───────────────────────────────────────────── */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      resolve();
    });
  });
}

/**
 * 等所有 `<img>` 解码完成（含失败）。
 *
 * `mountPrintDocument` 是把节点 importNode 进当前文档，图片会**重新发起一次加载**，
 * 渲染管线里那次等待不算数。截图前不等，图位就是一块白。
 */
async function waitForImages(timeoutMs: number): Promise<void> {
  const pending = Array.from(document.images).filter((image) => !image.complete);
  if (pending.length === 0) {
    return;
  }
  const settled = Promise.all(
    pending.map(
      (image) =>
        new Promise<void>((resolve) => {
          // error 也 resolve：一张加载不出来的图不该把整次分享拖到超时
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await Promise.race([settled, delay(timeoutMs)]);
}

/** 装载之后再等一轮：内联样式表是新解析的，字体会重新触发一次加载，布局要重走一遍 */
async function settleAfterMount(): Promise<void> {
  if (typeof document.fonts !== "undefined") {
    await Promise.race([document.fonts.ready, delay(FONT_SETTLE_TIMEOUT_MS)]);
  }
  await waitForImages(IMAGE_SETTLE_TIMEOUT_MS);
  await nextFrame();
  await nextFrame();
}

/* ── 4. 长图页入口 ─────────────────────────────────────────── */

/** 取父目录，作为本地图片相对路径基准；无分隔符（裸文件名）返回 null */
function parentDirOf(path: string): string | null {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index <= 0 ? null : path.slice(0, index);
}

/**
 * 渲染失败时的兜底页。
 *
 * 为什么失败也照样 emit PRINT_READY：不发信号的话 Rust 只能干等到超时，
 * 用户面对的是「点了分享，长时间没反应，最后拿到一张空图」。
 * 发信号 + 把原因画进图里，等待时间恢复正常，且拿到的图自己解释了发生什么。
 */
function mountFailurePage(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.setAttribute(PRINT_ERROR_ATTR, message);
  const block = document.createElement("pre");
  block.className = "md-print-failure";
  block.textContent = message;
  document.body.replaceChildren(block);
}

/**
 * 长图渲染窗口的前端入口：读原文 → 渲染 → 装载 → 套长图版式 → 发就绪信号。
 *
 * main.tsx 在 [`readLongImageJob`] 返回非 null 时调用本函数，并且**不要**挂载 React 应用：
 * 长图里出现顶栏/左栏，就等于把应用界面截图发给了同事。
 */
export async function renderLongImagePage(job: LongImageJob): Promise<void> {
  try {
    const payload = await readMarkdown(job.source);
    const html = await buildPrintDocument(payload.content, {
      // 长图不插目录页：它是一整条内容流，凭空多一屏目录只会让人以为发错了
      includeToc: false,
      baseDir: parentDirOf(job.source),
      title: payload.title,
      isLarge: payload.isLarge,
    });
    mountPrintDocument(html);
    applyLongImageCss(job.imageWidth);
    await settleAfterMount();
  } catch (error) {
    console.error("[long-image] failed to build the long image document", error);
    mountFailurePage(error);
  }

  document.documentElement.setAttribute(PRINT_READY_ATTR, "true");
  try {
    await emitPrintReady();
  } catch (error) {
    // 走到这里通常只有一个原因：渲染窗口没有被 capabilities 覆盖（core:event:allow-emit 缺失）。
    // Rust 侧会走超时分支照常截图，所以不抛错，只留一条可检索的日志。
    console.error(
      "[long-image] emit PRINT_READY failed (missing capability for the render window?)",
      error,
    );
  }
}

/* ── 5. 分段合成（超长文档） ───────────────────────────────── */

/** 合成结果。`bytes` 是 PNG 字节，直接可写文件；`width`/`height` 是设备像素。 */
export interface ComposedLongImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** 解码后的裸像素，供剪贴板使用（见下方 [`decodePngToRgba`] 的说明） */
export interface DecodedLongImage {
  rgba: Uint8Array;
  width: number;
  height: number;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        // 超出 Chromium 的 canvas 上限时 toBlob 就是静默给 null，没有异常可捕
        reject(new Error("canvas.toBlob returned null (canvas too large?)"));
        return;
      }
      blob
        .arrayBuffer()
        .then((buffer) => {
          resolve(new Uint8Array(buffer));
        })
        .catch(reject);
    }, "image/png");
  });
}

/**
 * 把 Rust 分段截来的 PNG（base64，顺序即从上到下）纵向拼成一张 PNG。
 *
 * 契约：入参正是 `capture_long_image({ output: null })` 回传的 `pngBase64`。
 * 段与段之间**没有重叠**（Rust 侧 `plan_segments` 保证首尾相接），所以按 y 累加即可。
 *
 * 超出 Chromium 的 canvas 上限（单边 65535 / 面积 16384²）时抛错，
 * 调用方应退回「保留 N 张分段图」而不是把失败当成整次分享失败——
 * N 张能发出去，一张发不出去的图等于没有。
 */
export async function composeSegments(segments: readonly string[]): Promise<ComposedLongImage> {
  if (segments.length === 0) {
    throw new Error("composeSegments called with no segments");
  }

  const bitmaps = await Promise.all(
    segments.map(async (segment) => {
      const blob = new Blob([base64ToBytes(segment)], { type: "image/png" });
      return createImageBitmap(blob);
    }),
  );

  try {
    const width = bitmaps.reduce((max, bitmap) => Math.max(max, bitmap.width), 0);
    const height = bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0);
    if (width <= 0 || height <= 0) {
      throw new Error("composeSegments got empty segments");
    }
    if (width > MAX_CANVAS_SIDE_PX || height > MAX_CANVAS_SIDE_PX) {
      throw new Error(`composed size ${width}x${height} exceeds the canvas side limit`);
    }
    if (width * height > MAX_CANVAS_AREA_PX) {
      throw new Error(`composed size ${width}x${height} exceeds the canvas area limit`);
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("failed to acquire a 2d canvas context");
    }
    // 段宽不齐时（理论上不会）右侧要有底色，不能留透明——微信会把透明渲染成黑色
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);

    let top = 0;
    for (const bitmap of bitmaps) {
      context.drawImage(bitmap, 0, top);
      top += bitmap.height;
    }

    const bytes = await canvasToPngBytes(canvas);
    return { bytes, width, height };
  } finally {
    for (const bitmap of bitmaps) {
      bitmap.close();
    }
  }
}

/**
 * PNG 字节 → 裸 RGBA。**剪贴板路径必须走这一步。**
 *
 * `clipboard-manager` 的 `writeImage` 最终落到 Rust 的 `Image::from_bytes`（PNG 解码），
 * 而那条路被 tauri 的 `image-png` feature 门着，本项目没开（开它 = 引入 `image` crate
 * 这个新运行时依赖，红线 12）。没开时插件只认 `{ rgba, width, height }` 这一种形态，
 * 所以解码必须在前端完成——反正浏览器本来就有解码器。
 */
export async function decodePngToRgba(bytes: Uint8Array): Promise<DecodedLongImage> {
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("failed to acquire a 2d canvas context");
    }
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      // 从 Uint8ClampedArray 拷一份出来：底层 buffer 随 canvas 走，留着引用等于留着整张画布
      rgba: new Uint8Array(data.data),
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}
