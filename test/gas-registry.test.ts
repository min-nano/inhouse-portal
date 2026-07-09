import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGasRegistry,
  listPortalCategories,
  mergeAutoApps,
  parseGasRegistry,
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

describe("parseGasRegistry", () => {
  it("正しい応答を検証して返す", () => {
    const res = parseGasRegistry({ apps: [gasApp()] });
    expect(res.apps[0]?.scriptId).toBe("ABC123");
  });

  it("https以外のurlを拒否する", () => {
    expect(() =>
      parseGasRegistry({ apps: [gasApp({ url: "http://x.example/exec" })] }),
    ).toThrow();
  });

  it("appsキーが無い応答を拒否する", () => {
    expect(() => parseGasRegistry({})).toThrow();
  });
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

describe("fetchGasRegistry", () => {
  it("上流を取得して検証済み応答を返す(cachesなし環境)", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ apps: [gasApp()] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchGasRegistry("https://script.google.com/macros/s/R/exec");
    expect(res.apps[0]?.scriptId).toBe("ABC123");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.redirect).toBe("follow");
  });

  it("上流が非200なら throw する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 500 })),
    );
    await expect(
      fetchGasRegistry("https://script.google.com/macros/s/R/exec"),
    ).rejects.toThrow();
  });

  it("壊れた応答は throw する(検証失敗)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })),
    );
    await expect(
      fetchGasRegistry("https://script.google.com/macros/s/R/exec"),
    ).rejects.toThrow();
  });
});
