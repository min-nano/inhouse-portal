export type AppEntry = {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  url: string;
  /** GASレジストリからの自動取得エントリなら true(「自動」バッジ表示用) */
  auto?: boolean;
};

export const ALL_CATEGORY = "すべて";

/** 検索語(名前・説明・タグ)とカテゴリでアプリ一覧を絞り込む */
export function filterApps(
  apps: AppEntry[],
  query: string,
  category: string,
): AppEntry[] {
  const q = query.trim().toLowerCase();
  return apps.filter((app) => {
    if (category !== ALL_CATEGORY && app.category !== category) {
      return false;
    }
    if (q === "") {
      return true;
    }
    const haystack = [app.name, app.description, ...app.tags]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}
