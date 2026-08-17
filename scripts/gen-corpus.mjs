#!/usr/bin/env node
/**
 * 压测语料生成（对应 package.json 的 `gen:corpus`）
 *
 * 用途：以 test-corpus/full-gfm.md 的内容循环拼接，生成 test-corpus/big-10mb.md。
 * 依据：DEV_GUIDE 12.0「标准测试语料库」——
 *       "big-10mb.md：10MB 压测文档（由 scripts/gen-corpus 以 full-gfm.md 内容循环拼接至
 *        10MB±5%，含 ≥500 个各级标题、≥100 个代码块、≥50 张表格，保证指标可比）"
 *       该文件不入库（见 .gitignore），每台机器本地生成。
 *
 * 关键处理：
 *   1) 源文件的 frontmatter 只保留在开头一份，循环体里剥掉——否则中间的 `---` 会被当分隔线。
 *   2) 每一轮的标题都带"轮次-序号"前缀，避免 500+ 个同名标题产生重复锚点（大纲跳转会串）。
 *   3) 代码围栏内的 `#` / `|` 不参与改写与统计，否则计数虚高、代码块内容被破坏。
 *
 * 用法：
 *   node scripts/gen-corpus.mjs [--mb=10] [--src=test-corpus/full-gfm.md] [--out=test-corpus/big-10mb.md]
 *
 * 退出码：0 = 生成成功且各项指标达标；1 = 源文件缺失或指标不达标；2 = 脚本自身异常。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** DG 12.0 的硬性下限 */
const MIN_HEADINGS = 500;
const MIN_CODE_BLOCKS = 100;
const MIN_TABLES = 50;
/** 体积容差 ±5% */
const SIZE_TOLERANCE = 0.05;
/** 循环上限，防止源文件过小时空转 */
const MAX_BLOCKS = 200000;

// ---------------------------------------------------------------------------
// 行级识别规则
// ---------------------------------------------------------------------------

/** ATX 标题：最多 3 个前导空格，1-6 个 #，允许结尾的收尾 # 串 */
const ATX_RE = /^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** 围栏起始/结束：``` 或 ~~~ */
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
/** setext 标题的下划线行 */
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
/** 表格分隔行（必须含 `|`，由调用方额外判断） */
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** 不可能是 setext 标题正文的行（列表/引用/表格/围栏等） */
const NOT_SETEXT_TEXT_RE = /^ {0,3}([-*+>|]|\d+[.)]|#{1,6}[ \t]|`{3,}|~{3,})/;

/**
 * 逐行处理一段内容：统计标题/代码块/表格，并按需为标题加序号。
 * @param {string[]} lines 待处理的行
 * @param {number|null} blockIndex 轮次编号；为 null 时只统计不改写
 * @returns {{ text: string, stats: { headings: number, byLevel: Record<number, number>, codeBlocks: number, tables: number } }}
 */
function processLines(lines, blockIndex) {
  const out = [];
  const stats = { headings: 0, byLevel: {}, codeBlocks: 0, tables: 0 };

  let fenceMarker = null; // 当前围栏的字符（` 或 ~）
  let fenceLength = 0;
  let localIndex = 0;

  const bumpHeading = (level) => {
    stats.headings += 1;
    stats.byLevel[level] = (stats.byLevel[level] ?? 0) + 1;
    localIndex += 1;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // ---- 围栏状态机：围栏内的一切原样保留 ----
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const length = fence[2].length;
      if (fenceMarker === null) {
        fenceMarker = marker;
        fenceLength = length;
        stats.codeBlocks += 1;
        out.push(line);
        continue;
      }
      // 结束围栏：字符相同且长度不短于起始围栏，且无 info string
      if (marker === fenceMarker && length >= fenceLength && fence[3].trim() === '') {
        fenceMarker = null;
        fenceLength = 0;
      }
      out.push(line);
      continue;
    }
    if (fenceMarker !== null) {
      out.push(line);
      continue;
    }

    // ---- ATX 标题 ----
    const atx = ATX_RE.exec(line);
    if (atx) {
      const level = atx[2].length;
      bumpHeading(level);
      out.push(blockIndex === null ? line : `${atx[1]}${atx[2]} ${blockIndex}-${localIndex} ${atx[3]}`);
      continue;
    }

    // ---- setext 标题（下一行是 === / ---）----
    const next = lines[i + 1];
    if (
      line.trim() !== '' &&
      !NOT_SETEXT_TEXT_RE.test(line) &&
      typeof next === 'string' &&
      SETEXT_RE.test(next)
    ) {
      const level = next.trim().startsWith('=') ? 1 : 2;
      bumpHeading(level);
      out.push(blockIndex === null ? line : `${blockIndex}-${localIndex} ${line}`);
      out.push(next);
      i += 1;
      continue;
    }

    // ---- 表格分隔行（上一行必须是表头，两行都得有竖线）----
    const prev = i > 0 ? lines[i - 1] : '';
    if (line.includes('|') && TABLE_DELIM_RE.test(line) && prev.includes('|')) {
      stats.tables += 1;
    }

    out.push(line);
  }

  return { text: out.join('\n'), stats };
}

/** 剥离开头的 YAML frontmatter，返回 { frontmatter, body } */
function splitFrontmatter(source) {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') return { frontmatter: '', body: source };
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '---' || trimmed === '...') {
      return {
        frontmatter: lines.slice(0, i + 1).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }
  return { frontmatter: '', body: source };
}

/** 补充段：每段贡献 2 个标题 + 1 个代码块 + 1 张表格，用于补齐 DG 12.0 的数量下限 */
function renderSupplement(n) {
  return [
    '',
    `## 补充段 S${n} 指标补齐区`,
    '',
    `本段由 scripts/gen-corpus.mjs 生成，用于把标题/代码块/表格数量补齐到 DEV_GUIDE 12.0 的下限。`,
    '',
    `### 补充段 S${n} 代码与表格`,
    '',
    '```ts',
    `export const supplement${n} = { index: ${n}, note: "压测语料填充" };`,
    '```',
    '',
    '| 列 A | 列 B | 列 C |',
    '| --- | :---: | ---: |',
    `| 行 ${n} 左对齐 | 居中 | 右对齐 |`,
    `| 中文内容 ${n} | 数字 ${n * 7} | \`code ${n}\` |`,
    '',
  ].join('\n');
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB（${bytes.toLocaleString('en-US')} 字节）`;
}

function parseArgs(argv) {
  const options = { mb: 10, src: 'test-corpus/full-gfm.md', out: 'test-corpus/big-10mb.md' };
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.+)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'mb') options.mb = Number(value);
    else if (key === 'src') options.src = value;
    else if (key === 'out') options.out = value;
  }
  if (!Number.isFinite(options.mb) || options.mb <= 0) {
    throw new Error(`--mb 参数非法：${options.mb}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const srcAbs = path.resolve(ROOT, options.src);
  const outAbs = path.resolve(ROOT, options.out);
  const target = Math.round(options.mb * 1024 * 1024);

  console.log('[gen-corpus] 生成压测语料，依据 DEV_GUIDE 12.0');

  if (!fs.existsSync(srcAbs)) {
    console.error(`[gen-corpus] 失败：源语料不存在 —— ${path.relative(ROOT, srcAbs)}`);
    console.error('[gen-corpus] big-10mb.md 由 full-gfm.md 循环拼接而来，请先准备好全 GFM 元素语料（DG 12.0）。');
    process.exit(1);
  }

  // 去 BOM + 统一换行，保证体积统计与行级识别可预期
  const raw = fs.readFileSync(srcAbs, 'utf8').replace(/^/, '').replace(/\r\n/g, '\n');
  const { frontmatter, body } = splitFrontmatter(raw);
  const bodyLines = body.replace(/^\n+/, '').replace(/\s+$/, '').split('\n');

  const probe = processLines(bodyLines, 1);
  const blockSize = Buffer.byteLength(probe.text, 'utf8');
  if (blockSize < 500) {
    console.error(`[gen-corpus] 失败：源语料正文过小（${blockSize} 字节），无法在合理轮次内拼到目标体积。`);
    process.exit(1);
  }
  if (blockSize > target * SIZE_TOLERANCE) {
    console.warn(
      `[gen-corpus] 警告：单轮体积 ${formatSize(blockSize)} 已超过目标的 ${SIZE_TOLERANCE * 100}%，` +
        '最终体积可能落在容差边缘。',
    );
  }

  const parts = [];
  let size = 0;
  const total = { headings: 0, byLevel: {}, codeBlocks: 0, tables: 0 };

  const accumulate = (stats) => {
    total.headings += stats.headings;
    total.codeBlocks += stats.codeBlocks;
    total.tables += stats.tables;
    for (const [level, count] of Object.entries(stats.byLevel)) {
      total.byLevel[level] = (total.byLevel[level] ?? 0) + count;
    }
  };

  const push = (text) => {
    parts.push(text);
    size += Buffer.byteLength(text, 'utf8');
  };

  // ---- 头部：源 frontmatter 保留一份 + 生成说明 ----
  if (frontmatter) push(`${frontmatter}\n\n`);
  const banner = [
    '# big-10mb 压测语料（自动生成，勿手工编辑）',
    '',
    `由 \`scripts/gen-corpus.mjs\` 以 \`${options.src}\` 循环拼接生成，依据 DEV_GUIDE 12.0。`,
    '重新生成：`pnpm gen:corpus`。',
    '',
  ].join('\n');
  const bannerResult = processLines(banner.split('\n'), null);
  accumulate(bannerResult.stats);
  push(`${bannerResult.text}\n`);

  // ---- 主体：循环拼接到目标体积 ----
  let blockCount = 0;
  while (size < target * (1 - 0.02) && blockCount < MAX_BLOCKS) {
    blockCount += 1;
    const block = processLines(bodyLines, blockCount);
    accumulate(block.stats);
    push(`\n---\n\n${block.text}\n`);
  }

  // ---- 补齐 DG 12.0 的数量下限（源语料元素密度不足时才会用到）----
  let supplementCount = 0;
  const upperBound = target * (1 + SIZE_TOLERANCE);
  while (
    (total.headings < MIN_HEADINGS || total.codeBlocks < MIN_CODE_BLOCKS || total.tables < MIN_TABLES) &&
    size < upperBound * 0.99
  ) {
    supplementCount += 1;
    const supplement = processLines(renderSupplement(supplementCount).split('\n'), null);
    accumulate(supplement.stats);
    push(`${supplement.text}\n`);
  }

  const content = parts.join('');
  const actualSize = Buffer.byteLength(content, 'utf8');
  const deviation = ((actualSize - target) / target) * 100;

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, content, 'utf8');

  // ---- 报告 ----
  const levelSummary = Object.keys(total.byLevel)
    .sort()
    .map((level) => `h${level}=${total.byLevel[level]}`)
    .join(' / ');

  console.log(`[gen-corpus] 输出文件：${path.relative(ROOT, outAbs)}`);
  console.log(`[gen-corpus] 实际体积：${formatSize(actualSize)}，目标 ${formatSize(target)}，偏差 ${deviation.toFixed(2)}%`);
  console.log(`[gen-corpus] 拼接轮次：${blockCount}（单轮 ${formatSize(blockSize)}），补充段 ${supplementCount} 段`);
  console.log(`[gen-corpus] 标题：${total.headings}（${levelSummary || '无'}）  下限 ${MIN_HEADINGS}`);
  console.log(`[gen-corpus] 代码块：${total.codeBlocks}  下限 ${MIN_CODE_BLOCKS}`);
  console.log(`[gen-corpus] 表格：${total.tables}  下限 ${MIN_TABLES}`);

  // ---- 达标判定 ----
  const failures = [];
  if (Math.abs(deviation) > SIZE_TOLERANCE * 100) {
    failures.push(`体积偏差 ${deviation.toFixed(2)}% 超出 ±${SIZE_TOLERANCE * 100}%`);
  }
  if (total.headings < MIN_HEADINGS) failures.push(`标题数 ${total.headings} < ${MIN_HEADINGS}`);
  if (total.codeBlocks < MIN_CODE_BLOCKS) failures.push(`代码块数 ${total.codeBlocks} < ${MIN_CODE_BLOCKS}`);
  if (total.tables < MIN_TABLES) failures.push(`表格数 ${total.tables} < ${MIN_TABLES}`);

  if (failures.length > 0) {
    console.error('');
    console.error('[gen-corpus] 失败：产物不满足 DEV_GUIDE 12.0 的规则 ——');
    for (const failure of failures) console.error(`  × ${failure}`);
    console.error('[gen-corpus] 处理建议：补充 full-gfm.md 的元素密度（标题/代码块/表格），或调整 --mb 后重跑。');
    process.exit(1);
  }

  console.log('[gen-corpus] 通过：体积与元素数量均满足 DEV_GUIDE 12.0。');
}

try {
  main();
} catch (error) {
  console.error('[gen-corpus] 脚本异常：', error instanceof Error ? error.message : error);
  process.exit(2);
}
