import { describe, expect, it } from "vitest";
import rawApps from "../data/apps.json";
import { listCategories, loadRegistry } from "../src/worker/registry";

const validApp = {
  id: "sample",
  name: "サンプル",
  description: "説明",
  category: "テスト",
  tags: ["gas"],
  url: "https://script.google.com/macros/s/XXX/exec",
};

describe("loadRegistry", () => {
  it("リポジトリ内の data/apps.json が有効な台帳である", () => {
    const registry = loadRegistry(rawApps);
    expect(registry.apps.length).toBeGreaterThan(0);
  });

  it("有効なエントリを受理する", () => {
    const registry = loadRegistry({ apps: [validApp] });
    expect(registry.apps[0]?.id).toBe("sample");
  });

  it("idの重複を拒否する", () => {
    expect(() =>
      loadRegistry({ apps: [validApp, { ...validApp, name: "別名" }] }),
    ).toThrow(/重複/);
  });

  it("http(非https)のURLを拒否する", () => {
    expect(() =>
      loadRegistry({
        apps: [{ ...validApp, url: "http://example.com/" }],
      }),
    ).toThrow();
  });

  it("不正な形式のidを拒否する", () => {
    expect(() =>
      loadRegistry({ apps: [{ ...validApp, id: "Bad_ID!" }] }),
    ).toThrow();
  });

  it("nameが空のエントリを拒否する", () => {
    expect(() =>
      loadRegistry({ apps: [{ ...validApp, name: "" }] }),
    ).toThrow();
  });
});

describe("listCategories", () => {
  it("登場順を保って重複なくカテゴリを列挙する", () => {
    const registry = loadRegistry({
      apps: [
        { ...validApp, id: "a", category: "設計" },
        { ...validApp, id: "b", category: "業務" },
        { ...validApp, id: "c", category: "設計" },
      ],
    });
    expect(listCategories(registry)).toEqual(["設計", "業務"]);
  });
});
