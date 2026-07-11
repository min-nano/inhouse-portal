/**
 * Phase 2: デプロイ済みGAS Webアプリの自動列挙(方式B: 本人権限)で得た一覧を、
 * apps.json の手動台帳とマージ(除外・表示上書き・重複排除)する純粋ロジック。
 *
 * 列挙そのもの(本人トークンで Drive/Apps Script API を叩く)は google-registry.ts、
 * ルーティング・キャッシュは app.ts が担当する。このモジュールは変換ロジックに
 * 徹する(テストしやすくするため)。
 */
import type { AppEntry, GasRegistryConfig } from "./registry";

/**
 * 自動取得エントリの url に許可するホスト。万一おかしな url が混ざっても、
 * 任意の https リンクが「自動」バッジ付きの信頼された見た目で並ぶのを防ぐ。
 * GAS WebアプリURLは script.google.com、実行結果は script.googleusercontent.com。
 */
const ALLOWED_AUTO_HOSTS = new Set([
  "script.google.com",
  "script.googleusercontent.com",
]);

function isAllowedAutoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_AUTO_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** 自動列挙で得た1エントリ(google-registry.ts が構築する)。 */
export type GasApp = {
  scriptId: string;
  name: string;
  url: string;
  /** 最新デプロイの更新時刻(RFC3339)。表示・並び替えの補助 */
  updateTime?: string;
};

/** ポータルへ返すアプリ。手動/自動を `auto` フラグで区別する。 */
export type PortalApp = AppEntry & { auto: boolean };

/** URLを正規化して重複判定に使う(末尾スラッシュ差などを吸収)。 */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/** scriptId から id 規則(英小文字・数字・ハイフン)に沿った安全なidを作る。 */
function slugId(scriptId: string): string {
  const slug = scriptId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `gas-${slug || "app"}`;
}

/**
 * 手動台帳(apps.json)と自動取得分をマージする。
 *
 * - `config.exclude` の scriptId、`overrides[scriptId].hidden` は除外
 * - 手動台帳と同じURLの自動エントリは抑制(手動が優先)
 * - `overrides[scriptId]` で name/description/category/tags を上書き
 * - id は手動・自動をまたいで一意化する
 *
 * 返り値は「手動(auto:false) → 自動(auto:true)」の順。
 */
export function mergeAutoApps(
  manual: AppEntry[],
  autoApps: GasApp[],
  config: GasRegistryConfig,
): PortalApp[] {
  const merged: PortalApp[] = manual.map((app) => ({ ...app, auto: false }));

  const usedIds = new Set(merged.map((a) => a.id));
  const manualUrls = new Set(merged.map((a) => normalizeUrl(a.url)));
  const excluded = new Set(config.exclude);

  /** id 衝突時に -2, -3 … を付けて一意化 */
  const uniqueId = (base: string): string => {
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  };

  for (const gasApp of autoApps) {
    if (excluded.has(gasApp.scriptId)) continue;
    // GAS由来でない url は信頼できないので除外(万一おかしな url が混ざっても、
    // 任意の https リンクが「自動」バッジ付きで並ばないようにする)
    if (!isAllowedAutoUrl(gasApp.url)) continue;
    const override = config.overrides[gasApp.scriptId];
    if (override?.hidden) continue;
    if (manualUrls.has(normalizeUrl(gasApp.url))) continue;

    merged.push({
      id: uniqueId(slugId(gasApp.scriptId)),
      name: override?.name ?? gasApp.name,
      description: override?.description ?? "",
      category: override?.category ?? config.defaultCategory,
      tags: override?.tags ?? ["gas"],
      url: gasApp.url,
      auto: true,
    });
  }

  return merged;
}

/** マージ後アプリのカテゴリ一覧(登場順・重複なし)。 */
export function listPortalCategories(apps: PortalApp[]): string[] {
  const categories: string[] = [];
  for (const app of apps) {
    if (!categories.includes(app.category)) categories.push(app.category);
  }
  return categories;
}
