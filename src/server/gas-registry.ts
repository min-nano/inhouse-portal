/**
 * Phase 2: GASレジストリ(デプロイ済みGAS Webアプリの自動列挙)。
 *
 * 「レジストリ」役のGAS Webアプリ(docs/phase2-gas-registry.md 参照)が
 * `{ apps: [{ scriptId, name, url, updateTime }] }` を返す。ここではその応答を
 *   1. zod で検証し
 *   2. apps.json の手動台帳とマージ(除外・表示上書き・重複排除)
 * する。GASへのHTTP取得(プロキシ+キャッシュ)は app.ts 側が担当し、この
 * モジュールは検証・変換の純粋ロジックに徹する(テストしやすくするため)。
 */
import { z } from "zod";
import type { AppEntry, GasRegistryConfig } from "./registry";

/** GASレジストリが返す1エントリ */
export const GasAppSchema = z.object({
  scriptId: z.string().min(1),
  name: z.string().min(1),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "urlはhttpsのみ許可"),
  /** 最新デプロイの更新時刻(RFC3339)。表示・並び替えの補助 */
  updateTime: z.string().optional(),
});

/** GASレジストリ Webアプリの応答全体 */
export const GasRegistryResponseSchema = z.object({
  apps: z.array(GasAppSchema),
});

export type GasApp = z.infer<typeof GasAppSchema>;
export type GasRegistryResponse = z.infer<typeof GasRegistryResponseSchema>;

/** ポータルへ返すアプリ。手動/自動を `auto` フラグで区別する。 */
export type PortalApp = AppEntry & { auto: boolean };

/** GAS応答(未検証)を検証して返す。不正なら ZodError を投げる。 */
export function parseGasRegistry(data: unknown): GasRegistryResponse {
  return GasRegistryResponseSchema.parse(data);
}

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

/** 既定キャッシュ時間(秒)。GAS呼び出しは数秒かかるため数分キャッシュする。 */
export const REGISTRY_CACHE_SECONDS = 300;

/** Cloudflare 実行環境の `caches.default`(あれば)を取り出す。テスト環境では undefined。 */
export function edgeCache(): Cache | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { default?: Cache }).default;
}

/**
 * GASレジストリを取得し、検証済みの応答を返す。
 * Cloudflare の Cache API が使える環境では数分キャッシュする(GAS呼び出しは遅い)。
 * 応答が壊れている場合は検証時に throw し、キャッシュもしない。
 */
export async function fetchGasRegistry(
  url: string,
  opts: { cacheSeconds?: number } = {},
): Promise<GasRegistryResponse> {
  const cacheSeconds = opts.cacheSeconds ?? REGISTRY_CACHE_SECONDS;
  const cacheKey = new Request(url, { method: "GET" });
  const cache = edgeCache();

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return parseGasRegistry(await hit.json());
  }

  // GAS は script.googleusercontent.com へ302するため follow する(proxy.ts と同様)
  const upstream = await fetch(url, { redirect: "follow" });
  if (!upstream.ok) {
    throw new Error(`GASレジストリ応答が異常です: HTTP ${upstream.status}`);
  }
  const text = await upstream.text();
  // 壊れた応答をキャッシュしないよう、検証を通してから put する
  const parsed = parseGasRegistry(JSON.parse(text));

  if (cache) {
    await cache.put(
      cacheKey,
      new Response(text, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `max-age=${cacheSeconds}`,
        },
      }),
    );
  }
  return parsed;
}
