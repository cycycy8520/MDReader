#!/usr/bin/env node
/**
 * Vditor 自托管资源裁剪拷贝
 *
 * 用途：把 node_modules/vditor/dist 里 DG 8 白名单内的资源复制到 vendor/vditor/，
 *       供应用离线加载（Vditor 的 `cdn` 参数默认指向 unpkg，离线即白屏）。
 * 依据：DEV_GUIDE 8 节「Vditor 资源自托管（硬性规定）」、「PlantUML / 执行型图表」；
 *       AI_DEV_GUIDE 第 7 节 M0-② 步骤 1；红线"产物出现 unpkg/jsdelivr 即失败"。
 *
 * 白名单：method.min.js + index.css + js/lute + js/mermaid
 *         + js/highlight.js（仅 GitHub Light/Dark 两套主题）+ js/katex（含字体）
 * 剔除：  mathjax、graphviz、echarts、markmap、abcjs、flowchart.js、plantuml
 *         （PlantUML 的本地文件只是 encoder，真正渲染依赖远程服务器 —— 离线不可用且是隐性外网请求）
 *
 * 目录结构必须保留 `dist/` 这一层：Vditor 内部按 `${cdn}/dist/js/lute/lute.min.js` 拼 URL，
 * 所以产物是 vendor/vditor/dist/...，前端把 `cdn` 指到 vendor/vditor 对应的服务路径即可。
 *
 * 用法：
 *   node scripts/fetch-vditor.mjs [--dry-run] [--no-sanitize]
 *
 * 退出码：0 = 成功；1 = 依赖缺失 / 白名单缺项 / 残留禁用域名；2 = 脚本自身异常。
 *
 * 注：脚本名叫 fetch 但不联网——资源来自已安装的 npm 包，联网下载由 pnpm install 负责。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST_ROOT = path.resolve(ROOT, 'vendor/vditor');
/** 目标目录里的 dist 层，不能省（见文件头说明） */
const DEST_DIST = path.join(DEST_ROOT, 'dist');

/** DG 8 白名单。accept 收到的是相对于该条目录的路径（分隔符已归一为 /） */
const WHITELIST = [
  { src: 'method.min.js', type: 'file', desc: '只读渲染入口（Vditor.preview / outlineRender）' },
  { src: 'index.css', type: 'file', desc: '基础样式' },
  {
    src: 'js/lute',
    type: 'dir',
    desc: 'Lute 解析内核（GFM / 脚注 / 任务列表）',
    accept: (rel) => /^lute(\.min)?\.js$/i.test(rel),
  },
  {
    src: 'js/mermaid',
    type: 'dir',
    desc: 'Mermaid 图表',
    accept: (rel) => /^mermaid(\.min)?\.js$/i.test(rel),
  },
  {
    src: 'js/highlight.js',
    type: 'dir',
    desc: '代码高亮（仅 GitHub Light / Dark 两套主题）',
    accept: (rel) =>
      /^highlight(\.min)?\.js$/i.test(rel) || /^styles\/(github|github-dark)(\.min)?\.css$/i.test(rel),
  },
  {
    src: 'js/katex',
    type: 'dir',
    desc: 'KaTeX 公式（含字体）',
    accept: (rel) => /^katex(\.min)?\.(js|css)$/i.test(rel) || /^fonts\//i.test(rel),
  },
];

/** DG 8 明确剔除的执行型图表 / 备选数学引擎（按目录名的小写子串匹配） */
const DENY_TOKENS = ['mathjax', 'graphviz', 'echarts', 'markmap', 'abcjs', 'flowchart', 'plantuml'];

/** 一律不复制的文件（sourcemap 只增体积） */
const GLOBAL_EXCLUDE = (rel) => /\.map$/i.test(rel);

/** 禁用域名关键字（DG 8） */
const NEEDLES = ['unpkg', 'jsdelivr'];
/** 消毒时用的替换值：RFC 6761 保留的 .invalid 顶级域，永远解析不了 —— 万一有代码路径漏传 cdn，是响亮的失败而不是静默外网请求 */
const NEUTRAL_HOST = 'vditor-cdn.invalid';
/** 需要做文本消毒的扩展名 */
const TEXT_EXT = new Set(['.js', '.css', '.html', '.htm', '.json', '.svg', '.txt']);

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 递归统计目录体积 */
function dirSize(abs) {
  let total = 0;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) total += dirSize(child);
    else if (entry.isFile()) total += fs.statSync(child).size;
  }
  return total;
}

/** 递归列出目录下所有文件（返回相对路径，分隔符归一为 /） */
function listFiles(abs, base = abs, out = []) {
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) listFiles(child, base, out);
    else if (entry.isFile()) out.push(path.relative(base, child).split(path.sep).join('/'));
  }
  return out;
}

/** 定位 node_modules/vditor/dist */
function resolveVditorDist() {
  const candidates = [path.resolve(ROOT, 'node_modules/vditor')];
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('vditor/package.json', { paths: [ROOT] });
    candidates.push(path.dirname(pkgPath));
  } catch {
    // 包未安装或未导出 package.json，交给下面的存在性判断报错
  }

  for (const pkgDir of candidates) {
    const dist = path.join(pkgDir, 'dist');
    if (fs.existsSync(dist) && fs.statSync(dist).isDirectory()) {
      let version = '未知';
      try {
        version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version ?? '未知';
      } catch {
        // 版本读不到不影响复制
      }
      return { dist, version, pkgDir };
    }
  }
  return null;
}

/** 复制单个文件（自动建目录），返回字节数 */
function copyFile(srcAbs, destAbs, dryRun) {
  const size = fs.statSync(srcAbs).size;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
  }
  return size;
}

/**
 * 文本消毒：把内置的默认 CDN 域名改写成不可解析的占位域名。
 * 为什么必须做：Vditor 的默认 `cdn` 常量（https://unpkg.com/vditor@x.y.z）就写死在 method.min.js 里，
 * 不改写的话 DG 8 的"产物不得出现 unpkg/jsdelivr"扫描必然失败。
 * 只改域名、不改 URL 结构，避免破坏 minified 代码里的字符串拼接。
 */
function sanitizeText(content) {
  let count = 0;
  let next = content.replace(/(?:cdn\.|fastly\.|gcore\.|test1\.)?jsdelivr\.net/gi, () => {
    count += 1;
    return NEUTRAL_HOST;
  });
  next = next.replace(/unpkg\.com/gi, () => {
    count += 1;
    return NEUTRAL_HOST;
  });
  // 兜底：注释 / sourceMappingURL 里残留的裸关键字
  next = next.replace(/unpkg|jsdelivr/gi, () => {
    count += 1;
    return 'vendored-cdn';
  });
  return { content: next, count };
}

/** 校验目录内是否残留禁用域名，返回命中列表 */
function verifyNoCdn(rootAbs) {
  const offenders = [];
  for (const rel of listFiles(rootAbs)) {
    const buf = fs.readFileSync(path.join(rootAbs, rel));
    const text = buf.toString('latin1').toLowerCase();
    for (const needle of NEEDLES) {
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        const excerpt = text.slice(Math.max(0, idx - 40), idx + 60).replace(/[^\x20-\x7e]/g, '.');
        offenders.push({ rel, needle, excerpt });
        break;
      }
    }
  }
  return offenders;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const sanitize = !argv.includes('--no-sanitize');

  console.log('[fetch-vditor] 按 DEV_GUIDE 8 节白名单裁剪自托管资源');

  const resolved = resolveVditorDist();
  if (!resolved) {
    console.error('[fetch-vditor] 失败：找不到 node_modules/vditor/dist。');
    console.error('[fetch-vditor] 请先 `pnpm install`（vditor 是运行时依赖，见 DG 4.1「渲染内核」行）。');
    process.exit(1);
  }
  console.log(`[fetch-vditor] 源：${path.relative(ROOT, resolved.dist) || resolved.dist}（vditor@${resolved.version}）`);
  console.log(`[fetch-vditor] 目标：${path.relative(ROOT, DEST_DIST)}${dryRun ? '（--dry-run，不落盘）' : ''}`);

  // ---- 清空旧产物，保证"删掉白名单条目后重跑"不会留下残渣 ----
  if (!dryRun && fs.existsSync(DEST_ROOT)) {
    fs.rmSync(DEST_ROOT, { recursive: true, force: true });
  }

  // ---- 按白名单复制 ----
  const report = [];
  const missing = [];
  let copiedBytes = 0;
  let copiedFiles = 0;

  for (const rule of WHITELIST) {
    const srcAbs = path.join(resolved.dist, rule.src);
    if (!fs.existsSync(srcAbs)) {
      missing.push(rule.src);
      continue;
    }

    let ruleBytes = 0;
    let ruleFiles = 0;
    let skippedFiles = 0;
    let skippedBytes = 0;

    if (rule.type === 'file') {
      ruleBytes += copyFile(srcAbs, path.join(DEST_DIST, rule.src), dryRun);
      ruleFiles += 1;
    } else {
      for (const rel of listFiles(srcAbs)) {
        if (GLOBAL_EXCLUDE(rel) || (rule.accept && !rule.accept(rel))) {
          skippedFiles += 1;
          skippedBytes += fs.statSync(path.join(srcAbs, rel)).size;
          continue;
        }
        ruleBytes += copyFile(path.join(srcAbs, rel), path.join(DEST_DIST, rule.src, rel), dryRun);
        ruleFiles += 1;
      }
      if (ruleFiles === 0) missing.push(`${rule.src}（目录存在但白名单内无匹配文件）`);
    }

    copiedBytes += ruleBytes;
    copiedFiles += ruleFiles;
    report.push({ src: rule.src, desc: rule.desc, files: ruleFiles, bytes: ruleBytes, skippedFiles, skippedBytes });
  }

  // ---- 体积汇总 ----
  console.log('');
  console.log('[fetch-vditor] 已复制（白名单）：');
  for (const row of report) {
    console.log(`  ${row.src.padEnd(20)} ${String(row.files).padStart(4)} 个文件  ${formatSize(row.bytes).padStart(10)}  ${row.desc}`);
  }
  console.log(`  ${'合计'.padEnd(19)} ${String(copiedFiles).padStart(4)} 个文件  ${formatSize(copiedBytes).padStart(10)}`);

  // 白名单目录内被过滤掉的文件（highlight.js 的其余主题、sourcemap 等）
  const filtered = report.filter((row) => row.skippedFiles > 0);
  if (filtered.length > 0) {
    console.log('');
    console.log('[fetch-vditor] 白名单目录内被过滤掉的文件：');
    for (const row of filtered) {
      console.log(`  ${row.src.padEnd(20)} ${String(row.skippedFiles).padStart(4)} 个文件  ${formatSize(row.skippedBytes).padStart(10)}  未列入白名单 / sourcemap`);
    }
  }

  // ---- 剔除清单：把 dist/js 下每个顶层条目的归属与体积都摊开，便于核对"到底省了多少" ----
  const jsDir = path.join(resolved.dist, 'js');
  if (fs.existsSync(jsDir)) {
    const kept = new Set(WHITELIST.filter((r) => r.src.startsWith('js/')).map((r) => r.src.slice(3)));
    const excluded = [];
    for (const entry of fs.readdirSync(jsDir, { withFileTypes: true })) {
      if (kept.has(entry.name)) continue;
      const abs = path.join(jsDir, entry.name);
      const size = entry.isDirectory() ? dirSize(abs) : fs.statSync(abs).size;
      const lower = entry.name.toLowerCase();
      const denied = DENY_TOKENS.some((token) => lower.includes(token));
      excluded.push({ name: entry.name, size, reason: denied ? 'DG 8 明确剔除' : '不在白名单' });
    }
    excluded.sort((a, b) => b.size - a.size);

    console.log('');
    console.log('[fetch-vditor] 已剔除（dist/js 下未复制的条目）：');
    let excludedBytes = 0;
    for (const row of excluded) {
      excludedBytes += row.size;
      console.log(`  ${row.name.padEnd(20)} ${formatSize(row.size).padStart(10)}  ${row.reason}`);
    }
    console.log(`  ${'合计省下'.padEnd(17)} ${formatSize(excludedBytes).padStart(10)}`);

    // 白名单目录内被过滤掉的文件（如 highlight.js 的其余主题）不在上表，单独提示一句
    const denyLeaked = listFiles(DEST_DIST).filter((rel) =>
      DENY_TOKENS.some((token) => rel.toLowerCase().includes(token)),
    );
    if (denyLeaked.length > 0) {
      console.error('[fetch-vditor] 失败：剔除清单里的资源混进了产物 ——');
      for (const rel of denyLeaked) console.error(`  × dist/${rel}`);
      process.exit(1);
    }
  }

  if (missing.length > 0) {
    console.error('');
    console.error('[fetch-vditor] 失败：白名单条目在源目录中缺失 ——');
    for (const item of missing) console.error(`  × ${item}`);
    console.error('[fetch-vditor] 可能是 vditor 版本变更导致目录结构调整（DG 4.1 要求 ≥3.11.3）。');
    console.error('[fetch-vditor] 按红线 12：先停下核对官方 dist 结构并与人类确认，不要自行改白名单。');
    process.exit(1);
  }

  if (dryRun) {
    console.log('');
    console.log('[fetch-vditor] --dry-run 结束（未写入 vendor/vditor，跳过消毒与校验）。');
    return;
  }

  // ---- 消毒：改写内置默认 CDN 域名 ----
  if (sanitize) {
    let touched = 0;
    let replaced = 0;
    for (const rel of listFiles(DEST_DIST)) {
      if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
      const abs = path.join(DEST_DIST, rel);
      const original = fs.readFileSync(abs, 'utf8');
      const { content, count } = sanitizeText(original);
      if (count > 0) {
        fs.writeFileSync(abs, content, 'utf8');
        touched += 1;
        replaced += count;
        console.log(`[fetch-vditor] 消毒 dist/${rel}：改写 ${count} 处 CDN 域名 → ${NEUTRAL_HOST}`);
      }
    }
    console.log(`[fetch-vditor] 消毒完成：${touched} 个文件 / ${replaced} 处（Vditor 内置默认 cdn 常量即在其中）。`);
  } else {
    console.log('[fetch-vditor] 已跳过消毒（--no-sanitize），下面的校验大概率会失败。');
  }

  // ---- 校验：产物内不得残留 unpkg / jsdelivr ----
  const offenders = verifyNoCdn(DEST_ROOT);
  if (offenders.length > 0) {
    console.error('');
    console.error('[fetch-vditor] 失败：产物中仍存在禁用域名字符串（DG 8 硬性规定）——');
    for (const row of offenders) {
      console.error(`  × vendor/vditor/${row.rel}  关键字 "${row.needle}"`);
      console.error(`      上下文：${row.excerpt}`);
    }
    process.exit(1);
  }

  const totalBytes = dirSize(DEST_ROOT);
  console.log('');
  console.log(`[fetch-vditor] 校验通过：vendor/vditor 内无 unpkg / jsdelivr，总体积 ${formatSize(totalBytes)}`);
  console.log('[fetch-vditor] 提醒：');
  console.log('  1) 前端必须显式传 `cdn` 指向本目录对应的服务路径（DG 8 硬性规定），且路径下要保留 dist/ 这一层；');
  console.log('  2) vendor/ 不入库（见 .gitignore），换机器/CI 都要重跑本脚本；');
  console.log('  3) 升级 vditor 前先跑 xss-suite 回归（DG 11 依赖版本纪律、AI_DEV_GUIDE 事实库 #10）。');

  const contentTheme = path.join(resolved.dist, 'css/content-theme');
  if (fs.existsSync(contentTheme)) {
    console.log(
      `  4) 检测到 dist/css/content-theme（${formatSize(dirSize(contentTheme))}）：不在 DG 8 白名单内，未复制。` +
        '若渲染层需要 theme.path，先改 DG 8 白名单再改本脚本。',
    );
  }
}

try {
  main();
} catch (error) {
  console.error('[fetch-vditor] 脚本异常：', error instanceof Error ? error.message : error);
  process.exit(2);
}
