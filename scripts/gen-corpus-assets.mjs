/**
 * 生成 test-corpus 需要的图片资源（二进制不入库，见 test-corpus/README.md 第 4 节）。
 *
 * 【为什么必须有这个脚本】README 一直只写着「自行放置任意 PNG」，于是实际情况是
 * **一张都没放**——full-gfm.md 第 10 节四个用例常年显示破图，其中 10.2「中文 + 空格路径」
 * 还是 DG 点名的头号坑。也就是说那条路径从来没有被真实验证过，只是"看起来测过了"。
 * 一句「自行放置」换不来验证，一个 `pnpm gen:corpus-assets` 才能。
 *
 * 刻意**不生成** `assets/不存在的图片-missing.png`：full-gfm.md 10.5 测的就是加载失败，
 * 那张图必须始终缺席。
 *
 * 零依赖：用 node:zlib 手写最小 PNG 编码（真彩色 8bit，逐行 filter 0）。
 * 引 sharp/canvas 只为画几个色块不成比例，也会拖慢安装。
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "test-corpus");

/** PNG 的 CRC32（表按需生成，够用即可） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * 画一张带边框与对角线的纯色图。
 *
 * 图案不是装饰：导出 PDF / 长图后要一眼看出「这张图有没有被裁掉、有没有被拉伸」，
 * 纯色块做不到这件事，边框 + 对角线可以。
 */
function makePng(width, height, [r, g, b]) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3); // 首字节是 filter type = 0
    for (let x = 0; x < width; x += 1) {
      // 边框 6px、两条对角线各 3px 宽，其余是底色
      const onBorder = x < 6 || y < 6 || x >= width - 6 || y >= height - 6;
      const onDiag1 = Math.abs(x * height - y * width) < width * 2;
      const onDiag2 = Math.abs((width - 1 - x) * height - y * width) < width * 2;
      const white = onBorder || onDiag1 || onDiag2;
      const offset = 1 + x * 3;
      row[offset] = white ? 255 : r;
      row[offset + 1] = white ? 255 : g;
      row[offset + 2] = white ? 255 : b;
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolour
  // 10..12 = compression / filter / interlace，全 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 与 test-corpus/README.md 第 4 节的表格逐行对应，改一处要同步改那里 */
const ASSETS = [
  ["assets/architecture.png", 640, 360, [37, 99, 235]],
  ["assets-cn path/示 例图.png", 480, 270, [16, 122, 87]],
  ["assets-cn path/架构图.png", 520, 300, [147, 51, 234]],
  ["assets-cn path/plain-ascii.png", 400, 240, [217, 119, 6]],
  ["assets-cn path/子 目录/深层 图片.png", 360, 200, [220, 38, 38]],
];

console.log("[gen-corpus-assets] 生成 test-corpus 图片资源（不入库，见 .gitignore）");
for (const [relative, width, height, color] of ASSETS) {
  const target = join(CORPUS, relative);
  mkdirSync(dirname(target), { recursive: true });
  const png = makePng(width, height, color);
  writeFileSync(target, png);
  console.log(`  ✓ ${relative}  ${width}×${height}  ${png.length} B`);
}
console.log(
  "[gen-corpus-assets] 完成。刻意不生成 assets/不存在的图片-missing.png —— " +
    "full-gfm.md 10.5 测的就是加载失败，那张必须一直缺席。",
);
