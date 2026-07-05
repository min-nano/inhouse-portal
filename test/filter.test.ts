import { describe, expect, it } from "vitest";
import { ALL_CATEGORY, filterApps, type AppEntry } from "../web/filter";

const apps: AppEntry[] = [
  {
    id: "report",
    name: "日報フォーム",
    description: "毎日の日報を入力",
    category: "業務管理",
    tags: ["gas", "フォーム"],
    url: "https://example.com/report",
  },
  {
    id: "drawings",
    name: "図面リスト",
    description: "案件ごとの図面管理",
    category: "設計ツール",
    tags: ["gas"],
    url: "https://example.com/drawings",
  },
];

describe("filterApps", () => {
  it("検索語もカテゴリ指定もなければ全件返す", () => {
    expect(filterApps(apps, "", ALL_CATEGORY)).toHaveLength(2);
  });

  it("カテゴリで絞り込む", () => {
    const result = filterApps(apps, "", "設計ツール");
    expect(result.map((a) => a.id)).toEqual(["drawings"]);
  });

  it("名前で検索できる", () => {
    expect(filterApps(apps, "日報", ALL_CATEGORY).map((a) => a.id)).toEqual([
      "report",
    ]);
  });

  it("タグで検索できる", () => {
    expect(
      filterApps(apps, "フォーム", ALL_CATEGORY).map((a) => a.id),
    ).toEqual(["report"]);
  });

  it("検索語とカテゴリはAND条件で効く", () => {
    expect(filterApps(apps, "gas", "設計ツール").map((a) => a.id)).toEqual([
      "drawings",
    ]);
    expect(filterApps(apps, "日報", "設計ツール")).toHaveLength(0);
  });

  it("大文字小文字を区別しない", () => {
    expect(filterApps(apps, "GAS", ALL_CATEGORY)).toHaveLength(2);
  });
});
