/**
 * settings 契约对拍单测（UPGRADE_PLAN 1.3）。
 *
 * 锁两件事：
 *   1. TS 侧 Settings 的**键集合**与 Rust `settings::Settings` 的 camelCase 序列化逐字一致
 *      （Rust 侧同名快照测在 src-tauri/src/settings.rs，两边改一处就会红一处）；
 *   2. 旧格式（readingFontSize / zoom / exportHtmlMode / showMetadata）能被迁移到新字段，
 *      用户升级后配置不失效。
 */

import { describe, expect, it, vi } from "vitest";

// 本测只验纯逻辑（契约键集合 / 迁移 / 排版变量），不碰 Tauri：
// mock 掉 ipc 后，settings.ts 的 import 链不会拉起 @tauri-apps/*，node 环境下可直接跑。
vi.mock("../services/ipc", () => ({
  loadSettings: () => Promise.resolve({}),
  saveSettings: () => Promise.resolve(),
}));

import { SETTINGS_KEYS } from "../types";
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  hasLegacySettingsKeys,
  migrateSettings,
  readingStyleVars,
} from "./settings";

/** 与 src-tauri/src/settings.rs 的 Settings 字段逐字对应（camelCase 序列化后） */
const RUST_WIRE_KEYS = [
  "theme",
  "fontSize",
  "zoomPercent",
  "codeWrap",
  "frontmatterDisplay",
  "outlinePinned",
  "sidebarWidth",
  "sidebarCollapsed",
  "htmlExportMode",
  "window",
];

describe("settings 前后端字段契约", () => {
  it("键集合与 Rust 侧逐字一致", () => {
    expect([...SETTINGS_KEYS].sort()).toEqual([...RUST_WIRE_KEYS].sort());
  });

  it("默认值对象只含契约字段", () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([...RUST_WIRE_KEYS].sort());
  });

  it("window 几何字段齐全", () => {
    expect(Object.keys(DEFAULT_SETTINGS.window).sort()).toEqual(
      ["height", "maximized", "width", "x", "y"].sort(),
    );
  });
});

describe("旧格式迁移", () => {
  const legacy = {
    theme: "dark",
    readingFontSize: 18,
    zoom: 125,
    codeWrap: true,
    showMetadata: false,
    outlinePinned: true,
    exportHtmlMode: "with-assets",
  };

  it("识别出旧字段", () => {
    expect(hasLegacySettingsKeys(legacy)).toBe(true);
    expect(hasLegacySettingsKeys(DEFAULT_SETTINGS)).toBe(false);
  });

  it("旧字段映射到新字段且不丢值", () => {
    const migrated = migrateSettings(legacy);
    expect(migrated.theme).toBe("dark");
    expect(migrated.fontSize).toBe(18);
    expect(migrated.zoomPercent).toBe(125);
    expect(migrated.codeWrap).toBe(true);
    expect(migrated.outlinePinned).toBe(true);
    expect(migrated.htmlExportMode).toBe("with-assets");
    // showMetadata:false → 三态的 hidden
    expect(migrated.frontmatterDisplay).toBe("hidden");
    // 旧格式没有的字段回落默认值
    expect(migrated.sidebarWidth).toBe(DEFAULT_SETTINGS.sidebarWidth);
    expect(migrated.window).toEqual(DEFAULT_SETTINGS.window);
  });

  it("新字段优先于同义旧字段", () => {
    const mixed = { ...legacy, fontSize: 14, zoomPercent: 90, frontmatterDisplay: "raw" };
    const migrated = migrateSettings(mixed);
    expect(migrated.fontSize).toBe(14);
    expect(migrated.zoomPercent).toBe(90);
    expect(migrated.frontmatterDisplay).toBe("raw");
  });

  it("越界/脏值一律钳位或回落，不抛错", () => {
    const dirty = migrateSettings({
      theme: "neon",
      fontSize: 999,
      zoomPercent: 1,
      sidebarWidth: 10_000,
      htmlExportMode: "zip",
      window: { x: "left", y: null, width: 10, height: 0, maximized: "yes" },
    });
    expect(dirty.theme).toBe("system");
    expect(dirty.fontSize).toBe(FONT_SIZE_MAX);
    expect(dirty.zoomPercent).toBe(ZOOM_MIN);
    expect(dirty.sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    expect(dirty.htmlExportMode).toBe("single-file");
    expect(dirty.window.x).toBeNull();
    expect(dirty.window.width).toBe(800);
    expect(dirty.window.maximized).toBe(false);

    expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(migrateSettings({ fontSize: 1, sidebarWidth: 1, zoomPercent: 999 })).toMatchObject({
      fontSize: FONT_SIZE_MIN,
      sidebarWidth: SIDEBAR_WIDTH_MIN,
      zoomPercent: ZOOM_MAX,
    });
  });
});

describe("阅读区排版变量", () => {
  it("字号带 px、缩放为无单位系数", () => {
    expect(readingStyleVars(16, 100)).toEqual({
      "--md-reading-font": "16px",
      "--md-zoom": "1.00",
    });
    expect(readingStyleVars(18, 125)["--md-zoom"]).toBe("1.25");
  });

  it("越界入参同样钳位（防止 UI 传入脏值把正文撑爆）", () => {
    expect(readingStyleVars(99, 999)).toEqual({
      "--md-reading-font": `${FONT_SIZE_MAX}px`,
      "--md-zoom": (ZOOM_MAX / 100).toFixed(2),
    });
  });
});
