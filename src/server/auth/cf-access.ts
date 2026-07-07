/**
 * Cloudflare Access が発行する JWT (`Cf-Access-Jwt-Assertion`) の署名検証。
 *
 * 公開鍵はチームの JWKS
 * (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) から取得する。
 * - `iss` は設定したチームドメインに固定 → 攻撃者が iss を差し替えて自前 JWKS を
 *   指すのを防ぐ。
 * - `aud` は Access アプリの Application Audience (AUD) タグに固定(設定時) →
 *   同一チーム内の別アプリのトークン再利用を防ぐ。
 * - `exp`(+ `nbf`)も検証。
 *
 * JWKS は isolate 内で TTL キャッシュし、未知の kid(鍵ローテート)を見たら取得し直す。
 */

export type CfAccessConfig = {
  /** "myteam" / "myteam.cloudflareaccess.com" / "https://myteam.cloudflareaccess.com" のいずれか */
  teamDomain: string;
  /** Access アプリの AUD タグ。設定時のみ aud を検証する */
  aud?: string;
};

export type CfAccessIdentity = { email?: string; sub?: string };

type Jwk = { kid?: string; kty?: string; alg?: string; n?: string; e?: string };
type Jwks = { keys?: Jwk[] };

function base64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(segment)));
}

/** teamDomain を正規化して issuer (`https://<team>.cloudflareaccess.com`) を返す */
export function normalizeIssuer(teamDomain: string): string {
  let d = teamDomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!d.includes(".")) d = `${d}.cloudflareaccess.com`;
  return `https://${d}`;
}

// --- JWKS キャッシュ (isolate内・TTL付き) ---
type CachedJwks = { keys: Map<string, CryptoKey>; fetchedAt: number };
const jwksCache = new Map<string, CachedJwks>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1時間

/** テスト用: キャッシュを消す */
export function resetAccessJwksCache(): void {
  jwksCache.clear();
}

async function importJwk(jwk: Jwk): Promise<CryptoKey | null> {
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return null;
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

async function fetchJwks(issuer: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const jwks = (await res.json()) as Jwks;
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys ?? []) {
    if (!jwk.kid) continue;
    const key = await importJwk(jwk);
    if (key) keys.set(jwk.kid, key);
  }
  return keys;
}

async function getKey(issuer: string, kid: string): Promise<CryptoKey | null> {
  const cached = jwksCache.get(issuer);
  const fresh = cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS;
  if (cached && fresh && cached.keys.has(kid)) {
    return cached.keys.get(kid) ?? null;
  }
  // 未キャッシュ / TTL切れ / kid未知(ローテート) → 取得し直す
  try {
    const keys = await fetchJwks(issuer);
    jwksCache.set(issuer, { keys, fetchedAt: Date.now() });
    if (keys.has(kid)) return keys.get(kid) ?? null;
  } catch {
    // 取得失敗時、期限切れでもキャッシュがあれば最後の望みで使う
  }
  return cached?.keys.get(kid) ?? null;
}

/**
 * Cf-Access-Jwt-Assertion を検証し、身元を返す。無効なら null。
 * @param now 現在時刻(秒)。テスト用に注入可能。
 */
export async function verifyAccessJwt(
  token: string,
  cfg: CfAccessConfig,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CfAccessIdentity | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];

    const header = decodeJsonSegment(h) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) return null;

    const issuer = normalizeIssuer(cfg.teamDomain);
    const key = await getKey(issuer, header.kid);
    if (!key) return null;

    // ArrayBuffer 裏付けの Uint8Array にして BufferSource として渡す
    const signature = new Uint8Array(base64urlToBytes(s));
    const signingInput = new Uint8Array(
      new TextEncoder().encode(`${h}.${p}`),
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      signingInput,
    );
    if (!ok) return null;

    const payload = decodeJsonSegment(p) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      nbf?: number;
      email?: string;
      sub?: string;
    };
    if (payload.iss !== issuer) return null;
    if (typeof payload.exp === "number" && payload.exp < now) return null;
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
    if (cfg.aud) {
      const auds = Array.isArray(payload.aud)
        ? payload.aud
        : payload.aud
          ? [payload.aud]
          : [];
      if (!auds.includes(cfg.aud)) return null;
    }
    return { email: payload.email, sub: payload.sub };
  } catch {
    return null;
  }
}
