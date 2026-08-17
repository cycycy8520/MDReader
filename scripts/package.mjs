/**
 * 一条命令产出两种交付物：NSIS 安装包 + 便携版 zip（DG F19）。
 *
 * 用法：
 *   pnpm package            完整构建（pnpm tauri build）后打两个包
 *   pnpm package --no-build 跳过构建，直接用现有产物打包（调试打包逻辑时用）
 *
 * 为什么要有这个脚本，而不是直接 pnpm tauri build：
 *   1. tauri build 只产 NSIS 安装包，没有便携形态；
 *   2. 便携版需要额外放 portable.marker 与使用说明，且必须与安装版**同一份 exe**
 *      （F19 的设计就是靠标记文件切换数据根目录，不做两套构建）；
 *   3. 收口交付物到 release/ 一个目录，避免每次去 target 深处翻文件。
 *
 * 重要（事实库 #17）：产物必须由 tauri build 生成。cargo build --release 的 exe
 * 会内嵌 devUrl 指向开发服务器，脱离 dev server 即白屏——本脚本因此绝不调 cargo build。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONF = path.join(ROOT, "src-tauri", "tauri.conf.json");
const RELEASE_DIR = path.join(ROOT, "src-tauri", "target", "release");
const OUT_DIR = path.join(ROOT, "release");

const skipBuild = process.argv.includes("--no-build");

function log(msg) {
  console.log(`[package] ${msg}`);
}

function fail(msg) {
  console.error(`[package] ✗ ${msg}`);
  process.exit(1);
}

/** 走 PowerShell 的 Compress-Archive：Windows 自带，免第三方 zip 依赖 */
function zipDir(srcDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
    ],
    { stdio: "inherit" },
  );
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ── 1. 读版本号 ────────────────────────────────────────────────
const conf = JSON.parse(fs.readFileSync(CONF, "utf8"));
const version = conf.version ?? "0.0.0";
const productName = conf.productName ?? "MDNaonao";
const binName = "mdnaonao.exe";
log(`产品 ${productName} v${version}`);

// ── 2. 构建（除非 --no-build）────────────────────────────────────
if (skipBuild) {
  log("跳过构建（--no-build），使用现有产物");
} else {
  log("执行 pnpm tauri build …（release 编译较慢）");
  // shell:true 让 Windows 能解析 pnpm.cmd
  execFileSync("pnpm", ["tauri", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
  });
}

// ── 3. 校验产物 ────────────────────────────────────────────────
const exePath = path.join(RELEASE_DIR, binName);
if (!fs.existsSync(exePath)) {
  fail(`找不到可执行文件：${exePath}（先跑 pnpm tauri build）`);
}

// ── 事实库 #17 的机器闸门 ──────────────────────────────────────
// 曾经的做法是搜 exe 里有没有 "localhost:1420" —— **那是错的**：tauri.conf.json 会被
// generate_context! 整体内嵌，devUrl 字段无论 dev/prod 都在字符串表里，必然误报。
// 真正要防的两件事换成下面两条可靠检查：
//   1) 前端产物是否比 exe 新 —— Tauri 在编译期内嵌 dist，只改前端时 cargo 认为无需重编，
//      exe 里就是旧界面（这个坑实际踩过一次，改了样式却看不到变化）。
//   2) exe 体积是否够大 —— 生产构建内嵌了压缩后的 dist（含 vendor/vditor 约 9MB 资源），
//      dev 构建不内嵌，两者体积差一个量级。
const exeStat = fs.statSync(exePath);

function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return newest;
}

const distDir = path.join(ROOT, "dist");
const distMtime = newestMtime(distDir);
if (distMtime > exeStat.mtimeMs + 1000) {
  fail(
    "dist/ 比 exe 新：exe 内嵌的是旧前端。\n" +
      "         只改前端时 cargo 不会重编 —— 先 touch 一个 .rs 文件或 cargo clean -p mdnaonao 再重跑。",
  );
}

// 阈值取自本机实测（2026-08-18，勿凭感觉改）：
//   cargo build --release（不内嵌 dist）→ 8.55 MB
//   pnpm tauri build（内嵌压缩后的 dist）→ 11.32 MB
// 取 10MB 卡在两者之间；前端资源变大时只会更安全。
const MIN_PROD_EXE_MB = 10;
if (exeStat.size < MIN_PROD_EXE_MB * 1024 * 1024) {
  fail(
    `exe 仅 ${humanSize(exeStat.size)}，小于生产构建应有的体积（≥${MIN_PROD_EXE_MB}MB）。\n` +
      "         多半是 cargo build 的产物（未内嵌 dist），脱离开发服务器会白屏。",
  );
}
log(`exe 校验通过（${humanSize(exeStat.size)}，内嵌前端不早于 dist）`);

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 4. 安装包：从 bundle 目录取出并统一命名 ──────────────────────
const nsisDir = path.join(RELEASE_DIR, "bundle", "nsis");
let setupOut = null;
if (fs.existsSync(nsisDir)) {
  const setup = fs.readdirSync(nsisDir).find((f) => f.endsWith(".exe"));
  if (setup) {
    setupOut = path.join(OUT_DIR, `${productName}_${version}_x64_setup.exe`);
    fs.copyFileSync(path.join(nsisDir, setup), setupOut);
    log(`安装包 → ${path.basename(setupOut)}（${humanSize(fs.statSync(setupOut).size)}）`);
  }
}
if (!setupOut) {
  log("⚠ 未找到 NSIS 安装包（--no-build 时可能尚未构建过），仅产出便携版");
}

// ── 5. 便携版：同一份 exe + marker + 说明 ────────────────────────
const portableName = `${productName}_${version}_x64_portable`;
const portableDir = path.join(OUT_DIR, portableName);
fs.mkdirSync(portableDir, { recursive: true });
fs.copyFileSync(exePath, path.join(portableDir, binName));

// 这个标记文件就是便携模式的开关（DG F19）：Rust 侧 settings::app_data_dir()
// 探测到它就把数据根目录切到 <exe目录>\data\
fs.writeFileSync(
  path.join(portableDir, "portable.marker"),
  [
    "此文件是便携模式的开关，请勿删除。",
    "",
    "存在此文件时，MDNaonao 会把全部数据写在同目录的 data\\ 子目录中：",
    "  data\\settings.json   设置",
    "  data\\recent.json     最近打开列表",
    "  data\\logs\\          运行日志",
    "",
    "删除此文件后，程序会改用 %APPDATA%\\MDNaonao（与安装版共用数据）。",
    "",
  ].join("\r\n"),
  "utf8",
);

fs.writeFileSync(
  path.join(portableDir, "使用说明.txt"),
  [
    `${productName} v${version} 便携版`,
    "",
    "【怎么用】",
    `解压到任意目录，双击 ${binName} 即可运行，无需安装。`,
    "可放在 U 盘随身携带；换电脑后设置与最近列表一并带走。",
    "",
    "【数据存在哪】",
    "全部数据写在本目录的 data\\ 子目录，不写入系统盘、不写注册表。",
    "删除整个目录即完全卸载，不留任何痕迹。",
    "",
    "【与安装版的区别】",
    "便携版不注册文件关联——双击 .md 文件不会用本程序打开，",
    "需要该功能请使用安装版。其余功能完全相同（同一份程序）。",
    "",
    "【运行要求】",
    "Windows 10/11 x64。界面渲染使用系统自带的 WebView2 运行时，",
    "Win11 及绝大多数 Win10 已内置；若提示缺少运行时，请从微软官网安装",
    "「Microsoft Edge WebView2 Runtime」（免费）。",
    "",
    "【注意】",
    "请勿解压到 C:\\Program Files 等需要管理员权限的目录，",
    "否则 data\\ 无法写入，设置将无法保存。",
    "",
  ].join("\r\n"),
  "utf8",
);

const zipPath = path.join(OUT_DIR, `${portableName}.zip`);
log("压缩便携版 …");
zipDir(portableDir, zipPath);
fs.rmSync(portableDir, { recursive: true, force: true });
log(`便携版 → ${path.basename(zipPath)}（${humanSize(fs.statSync(zipPath).size)}）`);

// ── 6. 校验和：发布页需要（DG 10-11）────────────────────────────
const lines = [];
for (const file of fs.readdirSync(OUT_DIR)) {
  const full = path.join(OUT_DIR, file);
  if (!fs.statSync(full).isFile() || file === "SHA256SUMS.txt") continue;
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-FileHash '${full}' -Algorithm SHA256).Hash`],
    { encoding: "utf8" },
  ).trim();
  lines.push(`${out.toLowerCase()}  ${file}`);
}
fs.writeFileSync(path.join(OUT_DIR, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");

console.log("");
log(`完成，产物在 release\\：`);
for (const line of lines) console.log(`         ${line}`);
