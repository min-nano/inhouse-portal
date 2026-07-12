/**
 * ハッシュ用の小さなユーティリティ。
 *
 * - sha256hex: 秘密性を要さないハッシュ(キャッシュキー等)。
 * - hmacSha256Hex: 鍵付きハッシュ。許可リストの個別メールを KV に置くとき、平文ではなく
 *   `HMAC-SHA256(AUTH_SECRET, "allowlist:"+email)` の hex を保存することで、KV 閲覧者が
 *   候補メールを総当たりしても(AUTH_SECRET を知らない限り)一致判定できないようにする。
 */

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256(hex)。キャッシュキー等、秘密性を要さないハッシュに使う。 */
export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * HMAC-SHA256(hex)。鍵は AUTH_SECRET。KV に置く識別子(許可リストの個別メール)を
 * **鍵付きハッシュ**にすることで、KV 閲覧者が候補メールを総当たりしても
 * (AUTH_SECRET を知らない限り)一致判定できないようにする。message に用途プレフィックスを
 * 付けて、用途間でハッシュが相関しないようにする。
 */
export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return toHex(new Uint8Array(sig));
}
