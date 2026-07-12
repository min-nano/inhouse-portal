/**
 * ハッシュ用の小さなユーティリティ。
 *
 * - sha256hex: 秘密性を要さないハッシュ(ユーザーごとのキャッシュキー等)。
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
