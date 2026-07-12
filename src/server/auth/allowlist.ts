/**
 * ログイン許可リスト。
 *
 * 機密度で2種類に分ける:
 * - **ドメイン**(例 `example.co.jp` / `*.example.co.jp`): 個人を特定しない低機密情報。
 *   env・KV とも平文で持つ。
 * - **個別メール**: PII で列挙されると困る。env(暗号化されたsecret変数)には平文で
 *   置いてよいが、**KV には平文で置かない**。`HMAC-SHA256(AUTH_SECRET, "allowlist:"+email)`
 *   のハッシュで保存し、KV 閲覧者が候補メールを総当たりしても
 *   (AUTH_SECRET を知らない限り)一致判定できないようにする。
 *
 * 最終的な許可リストは env と KV の和集合。KV はデプロイ無しで編集できるので、
 * 流動的な協力者の出入りに向く(ハッシュは `scripts/allowlist-hash.mjs` で算出)。
 */
import { hmacSha256Hex } from "./crypto";

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

/** 解決済みの許可リスト。 */
export type Allowlist = {
  /** 正規化済みドメインルール。"example.co.jp"(完全一致) or "*.example.co.jp"(サブドメイン) */
  domains: string[];
  /** 許可された個別メールの HMAC ハッシュ(hex)。 */
  emailHashes: Set<string>;
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** メールのドメイン部(最後の @ 以降)を小文字で返す。 */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/** 許可リスト用の個別メールハッシュ。KV に入れる値と同じ算出方法。 */
export async function allowlistEmailHash(
  email: string,
  secret: string,
): Promise<string> {
  return hmacSha256Hex(secret, `allowlist:${normalizeEmail(email)}`);
}

/**
 * ドメインルールの正規化。以下をすべて "example.co.jp" に、
 * `*@*.example.co.jp` / `*.example.co.jp` を "*.example.co.jp" に落とす。
 *   "example.co.jp" / "@example.co.jp" / "*@example.co.jp"
 * 個別メール(local@domain 形式)は null を返す(ドメインではない)。
 */
export function normalizeDomainRule(entry: string): string | null {
  let e = entry.trim().toLowerCase();
  if (!e) return null;
  if (e.startsWith("*@")) e = e.slice(2);
  else if (e.startsWith("@")) e = e.slice(1);
  // ここで local 部が残っていれば(= まだ @ を含む)個別メール扱い
  if (e.includes("@")) return null;
  if (!e) return null;
  return e; // "example.co.jp" or "*.example.co.jp"
}

/** env 文字列(カンマ/空白区切り)をドメインルール配列にする。 */
export function parseDomainsEnv(...raws: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    for (const entry of raw.split(/[,\s]+/)) {
      const rule = normalizeDomainRule(entry);
      if (rule) out.push(rule);
    }
  }
  return out;
}

/** env 文字列を個別メール(正規化済み)配列にする。 */
export function parseEmailsEnv(...raws: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    for (const entry of raw.split(/[,\s]+/)) {
      const e = normalizeEmail(entry);
      if (e && e.includes("@")) out.push(e);
    }
  }
  return out;
}

type KVAllowlist = { domains: string[]; emailHashes: string[]; legacyEmails: string[] };

/**
 * KV の許可リストを読む。推奨の新形式:
 *   { "domains": ["example.co.jp"], "emailHashes": ["<hex>", ...] }
 * 後方互換: 文字列配列 / `{ patterns: [...] }` も受ける。各要素はドメインなら
 * domains、個別メール(平文)なら legacyEmails に振り分ける(後でハッシュ化して照合)。
 * 未設定・不正JSONは空。
 */
export async function loadAllowlistFromKV(
  kv: KVNamespace | undefined,
): Promise<KVAllowlist> {
  const empty: KVAllowlist = { domains: [], emailHashes: [], legacyEmails: [] };
  if (!kv) return empty;
  const raw = await kv.get(ALLOWLIST_KEY);
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  // 新形式
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as {
      domains?: unknown;
      emailHashes?: unknown;
      patterns?: unknown;
    };
    if (obj.domains !== undefined || obj.emailHashes !== undefined) {
      return {
        domains: asStringArray(obj.domains)
          .map((s) => normalizeDomainRule(s))
          .filter((s): s is string => !!s),
        emailHashes: asStringArray(obj.emailHashes).map((s) =>
          s.trim().toLowerCase(),
        ),
        legacyEmails: [],
      };
    }
    // 後方互換 { patterns: [...] }
    return classifyLegacy(asStringArray(obj.patterns));
  }

  // 後方互換: 文字列配列
  return classifyLegacy(asStringArray(parsed));
}

/** 旧形式のエントリをドメイン/平文メールに振り分ける。 */
function classifyLegacy(entries: string[]): KVAllowlist {
  const domains: string[] = [];
  const legacyEmails: string[] = [];
  for (const entry of entries) {
    const domainRule = normalizeDomainRule(entry);
    if (domainRule) domains.push(domainRule);
    else {
      const e = normalizeEmail(entry);
      if (e.includes("@")) legacyEmails.push(e);
    }
  }
  return { domains, emailHashes: [], legacyEmails };
}

/**
 * env と KV を統合した許可リストを返す。個別メールはすべて HMAC ハッシュに揃える
 * (env の平文メール・KV の平文(後方互換)は resolve 時にハッシュ化)。
 */
export async function resolveAllowlist(
  env: {
    ALLOWED_EMAIL_DOMAINS?: string;
    ALLOWED_EMAILS?: string;
    AUTH_KV?: KVNamespace;
  },
  secret: string,
): Promise<Allowlist> {
  const fromKV = await loadAllowlistFromKV(env.AUTH_KV);

  const domains = [
    ...new Set([
      ...parseDomainsEnv(env.ALLOWED_EMAIL_DOMAINS, env.ALLOWED_EMAILS),
      ...fromKV.domains,
    ]),
  ];

  // env の個別メール + KV の平文(後方互換)をハッシュ化し、KV の emailHashes と統合。
  // secret が無い(= 個別メール許可リストを使わない・ドメインのみ運用)なら、平文メールの
  // ハッシュ化はスキップする(HMAC 鍵が無いので照合もできない)。`*@example.co.jp` のような
  // ワイルドカードは parseDomainsEnv 側でドメイン規則になるため、ドメイン一致は維持される。
  const plaintextEmails = secret
    ? [
        ...parseEmailsEnv(env.ALLOWED_EMAILS, env.ALLOWED_EMAIL_DOMAINS),
        ...fromKV.legacyEmails,
      ]
    : [];
  const hashed = await Promise.all(
    plaintextEmails.map((e) => allowlistEmailHash(e, secret)),
  );
  const emailHashes = new Set([
    ...(secret ? fromKV.emailHashes : []),
    ...hashed,
  ]);

  return { domains, emailHashes };
}

/** email のドメインが1つのドメインルールに一致するか。 */
export function matchesDomain(email: string, rule: string): boolean {
  const d = emailDomain(email);
  if (!d || !rule) return false;
  if (rule.startsWith("*.")) {
    // サブドメインのみ(apex は含めない)。"*.example.co.jp" → ".example.co.jp"
    return d.endsWith(rule.slice(1)) && d !== rule.slice(2);
  }
  return d === rule;
}

/** email が許可リストに含まれるか(ドメイン一致 or 個別メールのハッシュ一致)。 */
export async function isAllowed(
  email: string,
  allowlist: Allowlist,
  secret: string,
): Promise<boolean> {
  if (allowlist.domains.some((rule) => matchesDomain(email, rule))) return true;
  if (allowlist.emailHashes.size === 0 || !secret) return false;
  const hash = await allowlistEmailHash(email, secret);
  return allowlist.emailHashes.has(hash);
}
