/**
 * Google リフレッシュトークンの保管(暗号化 + KV)。
 *
 * - 値は crypto.ts で AES-256-GCM 暗号化してから KV に置く(平文で保存しない)。
 *   復号には AUTH_SECRET が必要なため、KV 単体が漏れても復号できない。
 * - KV キーは email の SHA-256(平文メールをキーに使わない)。
 * - 連携解除で delete。AUTH_SECRET のローテートでも(復号不能になり)実質失効する。
 */
import type { KVNamespace } from "./allowlist";
import { decryptString, encryptString, hmacSha256Hex } from "./crypto";

const KEY_PREFIX = "gtoken:";

/** 保管するトークンレコード(将来の拡張に備え scope/連携時刻も持つ)。 */
export type StoredToken = {
  refreshToken: string;
  scope?: string;
  connectedAt: number;
};

/**
 * KV キー。email を AUTH_SECRET 由来の HMAC でハッシュ化する(平文PIIを使わず、
 * かつ候補メールの総当たりで連携有無を判定されないようにする)。用途プレフィックスで
 * 許可リストのハッシュとも相関しないようにする。
 */
async function kvKey(email: string, secret: string): Promise<string> {
  return (
    KEY_PREFIX + (await hmacSha256Hex(secret, `gtoken:${email.trim().toLowerCase()}`))
  );
}

/** リフレッシュトークンを暗号化して保存する。 */
export async function saveRefreshToken(
  kv: KVNamespace,
  secret: string,
  email: string,
  record: StoredToken,
): Promise<void> {
  const blob = await encryptString(JSON.stringify(record), secret);
  await kv.put(await kvKey(email, secret), blob);
}

/** 保存済みトークンレコードを復号して返す。無い/復号失敗は null。 */
export async function loadStoredToken(
  kv: KVNamespace,
  secret: string,
  email: string,
): Promise<StoredToken | null> {
  const blob = await kv.get(await kvKey(email, secret));
  if (!blob) return null;
  const json = await decryptString(blob, secret);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as StoredToken;
    if (!parsed || typeof parsed.refreshToken !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 連携状態(トークン保存の有無)だけを軽く確認する。 */
export async function isConnected(
  kv: KVNamespace,
  secret: string,
  email: string,
): Promise<boolean> {
  return (await kv.get(await kvKey(email, secret))) !== null;
}

/** 保存済みトークンを削除する(連携解除)。 */
export async function deleteStoredToken(
  kv: KVNamespace,
  secret: string,
  email: string,
): Promise<void> {
  await kv.delete(await kvKey(email, secret));
}
