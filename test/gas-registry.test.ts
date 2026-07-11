import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPortalCategories,
  mergeAutoApps,
  type GasApp,
} from "../src/server/gas-registry";
import { resolveGasRegistryConfig, loadRegistry } from "../src/server/registry";
import type { AppEntry } from "../src/server/registry";

const manual: AppEntry[] = [
  {
    id: "nippou",
    name: "日報",
    description: "手動",
    category: "業務管理",
    tags: ["gas"],
    url: "https://script.google.com/macros/s/MANUAL/exec",
  },
];

const gasApp = (over: Partial<GasApp> = {}): GasApp => ({
  scriptId: "ABC123",
  name: "図面リスト",
  url: "https://script.google.com/macros/s/AUTO1/exec",
  updateTime: "2026-07-01T00:00:00Z",
  ...over,
});

const emptyConfig = resolveGasRegistryConfig(loadRegistry({ apps: [] }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mergeAutoApps", () => {
  it("手動を先頭に、自動を後ろに置き auto フラグを付ける", () => {
    const merged = mergeAutoApps(manual, [gasApp()], emptyConfig);
    expect(merged.map((a) => [a.name, a.auto])).toEqual([
      ["日報", false],
      ["図面リスト", true],
    ]);
    expect(merged[1]?.id).toMatch(/^gas-/);
    expect(merged[1]?.category).toBe("自動取得");
  });

  it("exclude の scriptId を除外する", () => {
    const config = resolveGasRegistryConfig(
      loadRegistry({ apps: [], gasRegistry: { exclude: ["ABC123"] } }),
    );
    const merged = mergeAutoApps(manual, [gasApp()], config);
    expect(merged.filter((a) => a.auto)).toHaveLength(0);
  });

  it("override で name/category/tags を上書きし hidden は除外する", () => {
    const config = resolveGasRegistryConfig(
      loadRegistry({
        apps: [],
        gasRegistry: {
          overrides: {
            ABC123: { name: "図面台帳", category: "設計ツール", tags: ["図面"] },
            HIDE1: { hidden: true },
          },
        },
      }),
    );
    const merged = mergeAutoApps(
      manual,
      [gasApp(), gasApp({ scriptId: "HIDE1", url: "https://script.google.com/macros/s/H/exec" })],
      config,
    );
    const auto = merged.filter((a) => a.auto);
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({
      name: "図面台帳",
      category: "設計ツール",
      tags: ["図面"],
    });
  });

  it("手動台帳と同じURL(末尾スラッシュ差含む)の自動分は抑制する", () => {
    const dup = gasApp({
      scriptId: "DUP",
      url: "https://script.google.com/macros/s/MANUAL/exec/",
    });
    const merged = mergeAutoApps(manual, [dup], emptyConfig);
    expect(merged.filter((a) => a.auto)).toHaveLength(0);
  });

  it("id衝突を一意化する", () => {
    const merged = mergeAutoApps(
      [],
      [
        gasApp({ scriptId: "abc", url: "https://script.google.com/macros/s/1/exec" }),
        gasApp({ scriptId: "ABC", url: "https://script.google.com/macros/s/2/exec" }),
      ],
      emptyConfig,
    );
    const ids = merged.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("listPortalCategories", () => {
  it("登場順・重複なしでカテゴリを返す", () => {
    const merged = mergeAutoApps(manual, [gasApp()], emptyConfig);
    expect(listPortalCategories(merged)).toEqual(["業務管理", "自動取得"]);
  });
});

describe("mergeAutoApps: 信頼できない url の除外", () => {
  it("許可ホスト以外・https以外の自動エントリは除外する", () => {
    const merged = mergeAutoApps(
      [],
      [
        gasApp({ scriptId: "EVIL", url: "https://evil.example/exec" }),
        gasApp({ scriptId: "HTTP", url: "http://script.google.com/x/exec" }),
      ],
      emptyConfig,
    );
    expect(merged.filter((a) => a.auto)).toHaveLength(0);
  });
});
