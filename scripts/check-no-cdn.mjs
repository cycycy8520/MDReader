#!/usr/bin/env node
/**
 * 禁用域名扫描（对应 package.json 的 `check:no-cdn`）
 *
 * 用途：扫描构建产物，确认其中不含 `unpkg` / `jsdelivr` 字符串。
 *       Vditor 默认从 unpkg 动态加载资源，离线即白屏——所以 DG 8 把"产物零 CDN 引用"
 *       定为硬性规定，本脚本就是这条规定的执行者。
 * 依据：DEV_GUIDE 8 节「Vditor 资源自托管（硬性规定）」、11.3 CI；AI_DEV_GUIDE 第 7 节 M0-0。
 *
 * 用法：
 *   node scripts/check-no-cdn.mjs [额外扫描目录...]
 * 默认扫描：dist/ 与 src-tauri/target/release/
 *
 * 退出码：
 *   0 = 干净，或 M0 阶段尚无任何产物（打印提示，不误红）
 *   1 = 命中禁用域名（打印命中文件、偏移量与上下文片段）
 *   2 = 脚本自身异常
 *
 * 说明：产物里既有文本（js/css/html）也有二进制（exe/nsis 安装包），字符串在二进制里
 *       可能是 UTF-8 也可能是 UTF-16LE，所以下面三种视图都要扫。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 禁用关键字（小写比对） */
const NEEDLES = ['unpkg', 'jsdelivr'];

/**
 * 默认扫描目标。
 * cargo 的中间产物目录（deps/build/incremental/.fingerprint）里全是编译缓存，
 * 体量巨大且不进安装包，跳过以免把扫描拖成分钟级。
 */
const DEFAULT_TARGETS = [
  { dir: 'dist', skipDirs: [] },
  {
    dir: 'src-tauri/target/release',
    skipDirs: ['deps', 'build', 'incremental', '.fingerprint', 'examples', 'wbuild'],
  },
];

/** 单文件最多报告几处命中（避免刷屏） */
const MAX_HITS_PER_FILE = 5;
/** 分块读取大小（8MB）；块间保留重叠，防止关键字被切断 */
const CHUNK_SIZE = 8 * 1024 * 1024;
const OVERLAP = 64;

/** 把字节数格式化成人类可读体积 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 取命中处的上下文片段，非可打印字符统一替换成 '.' */
function excerptAt(buf, index, needleLen) {
  const start = Math.max(0, index - 40);
  const end = Math.min(buf.length, index + needleLen + 40);
  let text = buf.toString('latin1', start, end);
  text = text.replace(/[^\x20-\x7e]/g, '.');
  return text;
}

/**
 * 在一个数据块里查找禁用关键字。
 * 三种视图：
 *   1) latin1 —— 覆盖 ASCII / UTF-8（关键字本身全是 ASCII）
 *   2) utf16le 对齐偏移 0
 *   3) utf16le 对齐偏移 1（PE 文件里的宽字符串未必按偶数地址起始）
 * @returns {{needle: string, offset: number, encoding: string, index: number}[]}
 */
function findNeedles(buf, baseOffset) {
  const hits = [];

  const views = [
    { encoding: 'utf8/ascii', text: buf.toString('latin1').toLowerCase(), scale: 1, shift: 0 },
    { encoding: 'utf16le', text: buf.toString('utf16le').toLowerCase(), scale: 2, shift: 0 },
    { encoding: 'utf16le+1', text: buf.subarray(1).toString('utf16le').toLowerCase(), scale: 2, shift: 1 },
  ];

  for (const view of views) {
    for (const needle of NEEDLES) {
      let from = 0;
      for (;;) {
        const idx = view.text.indexOf(needle, from);
        if (idx === -1) break;
        const byteIndex = idx * view.scale + view.shift;
        hits.push({
          needle,
          encoding: view.encoding,
          offset: baseOffset + byteIndex,
          index: byteIndex,
        });
        from = idx + needle.length;
        if (hits.length > MAX_HITS_PER_FILE * NEEDLES.length * 3) break;
      }
    }
  }

  return hits;
}

/** 扫描单个文件，返回命中列表 */
function scanFile(absPath) {
  const hits = [];
  const stat = fs.statSync(absPath);
  const fd = fs.openSync(absPath, 'r');

  try {
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let position = 0;
    let carry = Buffer.alloc(0);

    while (position < stat.size) {
      const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, position);
      if (bytesRead <= 0) break;

      const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const chunkBase = position - carry.length;

      for (const hit of findNeedles(chunk, chunkBase)) {
        // 落在上一块重叠区里的命中已经报过，跳过
        if (carry.length > 0 && hit.index < carry.length - hit.needle.length) continue;
        if (hits.length >= MAX_HITS_PER_FILE) break;
        hits.push({
          needle: hit.needle,
          encoding: hit.encoding,
          offset: hit.offset,
          excerpt: excerptAt(chunk, hit.index, hit.needle.length),
        });
      }

      if (hits.length >= MAX_HITS_PER_FILE) break;

      position += bytesRead;
      carry = chunk.subarray(Math.max(0, chunk.length - OVERLAP));
    }
  } finally {
    fs.closeSync(fd);
  }

  return hits;
}

/** 递归遍历目录，返回文件绝对路径列表 */
function walk(dirAbs, skipDirs, out = []) {
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, entry.name);
    if (entry.isSymbolicLink()) continue; // 不跟随符号链接，避免环
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      walk(abs, skipDirs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function main() {
  const extraDirs = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const targets = [...DEFAULT_TARGETS, ...extraDirs.map((dir) => ({ dir, skipDirs: [] }))];

  const startedAt = Date.now();
  const existing = [];
  const missing = [];

  for (const target of targets) {
    const abs = path.resolve(ROOT, target.dir);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      existing.push({ ...target, abs });
    } else {
      missing.push(target.dir);
    }
  }

  console.log('[check-no-cdn] 禁用域名扫描（unpkg / jsdelivr），依据 DEV_GUIDE 8 节');

  if (existing.length === 0) {
    console.log(`[check-no-cdn] 未发现任何产物目录：${missing.join('、')}`);
    console.log('[check-no-cdn] 跳过扫描（构建后再跑本脚本即可）。M0 阶段属正常情况，不视为失败。');
    process.exit(0);
  }

  let fileCount = 0;
  let byteCount = 0;
  const offenders = [];

  for (const target of existing) {
    const files = walk(target.abs, target.skipDirs);
    console.log(`[check-no-cdn] 扫描目录 ${target.dir}（${files.length} 个文件）`);

    for (const file of files) {
      fileCount += 1;
      byteCount += fs.statSync(file).size;
      const hits = scanFile(file);
      if (hits.length > 0) {
        offenders.push({ file: path.relative(ROOT, file), hits });
      }
    }
  }

  if (missing.length > 0) {
    console.log(`[check-no-cdn] 以下目录不存在，已跳过：${missing.join('、')}`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[check-no-cdn] 共扫描 ${fileCount} 个文件 / ${formatSize(byteCount)}，耗时 ${elapsed}s`);

  if (offenders.length === 0) {
    console.log('[check-no-cdn] 通过：产物中未出现 unpkg / jsdelivr。');
    process.exit(0);
  }

  console.error('');
  console.error(`[check-no-cdn] 失败：${offenders.length} 个文件命中禁用域名字符串。`);
  for (const offender of offenders) {
    console.error(`  × ${offender.file}`);
    for (const hit of offender.hits) {
      console.error(`      关键字 "${hit.needle}"  偏移 ${hit.offset}  编码 ${hit.encoding}`);
      console.error(`      上下文：${hit.excerpt}`);
    }
  }
  console.error('');
  console.error('修复方向：');
  console.error('  1) Vditor 的 cdn 参数必须指向打包进应用的本地目录（DG 8 硬性规定），不能用默认值；');
  console.error('  2) vendor/vditor 由 scripts/fetch-vditor.mjs 生成，它会改写内置的默认 CDN 常量——');
  console.error('     若这里仍有命中，先重跑 `node scripts/fetch-vditor.mjs` 再重新构建；');
  console.error('  3) 若命中来自新引入的第三方库，说明该库自带外链资源，按红线 12 先与人类确认。');
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error('[check-no-cdn] 脚本异常：', error instanceof Error ? error.message : error);
  process.exit(2);
}
