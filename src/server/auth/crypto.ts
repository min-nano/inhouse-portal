/**
 * 保管用の対称暗号(AES-256-GCM)。
 *
 * Google のリフレッシュトークン等の「長期秘密」を KV に平文で置かないための
 * 封筒暗号。鍵は AUTH_SECRET から HKDF-SHA256 で導出する。したがって
 * **KV が漏れただけでは復号できず**、AUTH_SECRET(別管理のsecret)も必要になる。
 * AUTH_SECRET をローテートすると既存の暗号文は全て復号不能になり、実質失効する。
 *
 * 形式: base64url( iv(12B) || ciphertext+tag )
 */

const IV_BYTES = 12;
const HKDF_INFO = "portal:token-encryption:v1";

function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** AUTH_SECRET から AES-GCM 用の 256bit 鍵を HKDF で導出する。 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // salt は固定でもよい(secret 自体が高エントロピー前提)。info で用途を分離。
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 平文を暗号化して base64url 文字列にする。 */
export async function encryptString(
  plaintext: string,
  secret: string,
): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return base64urlEncode(out);
}

/** encryptString の逆。改ざん・鍵不一致・不正形式は null を返す。 */
export async function decryptString(
  blob: string,
  secret: string,
): Promise<string | null> {
  try {
    const bytes = base64urlDecode(blob);
    if (bytes.length <= IV_BYTES) return null;
    const iv = bytes.slice(0, IV_BYTES);
    const ct = bytes.slice(IV_BYTES);
    const key = await deriveKey(secret);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
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
 * HMAC-SHA256(hex)。鍵は AUTH_SECRET。KV に置く識別子(許可リストの個別メール、
 * トークンのキー)を **鍵付きハッシュ**にすることで、KV 閲覧者が候補メールを
 * 総当たりしても(AUTH_SECRET を知らない限り)一致判定できないようにする。
 * message に用途プレフィックスを付けて、用途間でハッシュが相関しないようにする。
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
