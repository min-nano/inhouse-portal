/**
 * ログイン許可リスト。
 *
 * - エントリはメールアドレスのパターン。`*` を任意長のワイルドカードとして使える
 *   (全文一致・大文字小文字無視)。例:
 *     "*@example.co.jp"    … example.co.jp ドメインの全員 (社内)
 *     "taro@partner.com"   … 個別の協力者
 *     "*@*.example.co.jp"  … サブドメイン配下も許可
 * - ソースは env(ベースライン) と KV(運用中に追加・失効する分) の和集合。
 *   KV を使うとデプロイ無しでダッシュボードから許可リストを編集できる。
 */

/** このコードが使う範囲だけの最小 KV 型 (@cloudflare/workers-types を持ち込まない) */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ALLOWLIST_KEY = "allowlist";

/** env の文字列(カンマ/空白区切り)を正規化したパターン配列にする */
export function parseAllowlistEnv(
  ...raws: (string | undefined)[]
): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    for (const entry of raw.split(/[,\s]+/)) {
      const trimmed = entry.trim().toLowerCase();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/**
 * KV に保存された許可リストを読む。
 * 値は JSON の文字列配列 `["*@example.co.jp", ...]`、または
 * `{ "patterns": [...] }` のどちらでも受け付ける。未設定・不正は空配列。
 */
export async function loadAllowlistFromKV(
  kv: KVNamespace | undefined,
): Promise<string[]> {
  if (!kv) return [];
  const raw = await kv.get(ALLOWLIST_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { patterns?: unknown }).patterns)
      ? (parsed as { patterns: unknown[] }).patterns
      : [];
  return list
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** env と KV を統合した許可リストを返す(重複除去) */
export async function resolveAllowlist(env: {
  ALLOWED_EMAIL_DOMAINS?: string;
  ALLOWED_EMAILS?: string;
  AUTH_KV?: KVNamespace;
}): Promise<string[]> {
  const fromEnv = parseAllowlistEnv(env.ALLOWED_EMAIL_DOMAINS, env.ALLOWED_EMAILS);
  const fromKV = await loadAllowlistFromKV(env.AUTH_KV);
  return [...new Set([...fromEnv, ...fromKV])];
}

/** 1件のパターンに対する一致判定 (`*` は任意長・全文一致・大文字小文字無視) */
export function matchesPattern(email: string, pattern: string): boolean {
  const e = email.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!e || !p) return false;
  if (!p.includes("*")) return e === p;
  const escaped = p
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(e);
}

/** email が許可リストのいずれかに一致するか */
export function isAllowed(email: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(email, p));
}
