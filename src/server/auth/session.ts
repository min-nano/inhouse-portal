/**
 * 自前セッション(署名済みJWT)とCookieの取り扱い。
 *
 * - セッションは HMAC-SHA256 で署名した自己完結型JWT。検証にKVを引かないので
 *   毎リクエストのコストはほぼゼロ。失効は AUTH_SECRET のローテートで全消し、
 *   個別失効は許可リストからの除外(再ログイン不可)+ TTL 経過で行う。
 * - Cookie 名は SESSION_COOKIE。middleware は生の Request から、
 *   Hono ルートは c.req.raw から同じ関数で読み取れる。
 */
import { sign, verify } from "hono/jwt";

export const SESSION_COOKIE = "portal_session";
export const OAUTH_COOKIE = "portal_oauth";

/** セッションTTL(時間)の既定値: 7日 */
export const DEFAULT_SESSION_TTL_HOURS = 24 * 7;

export type SessionUser = { email: string; name?: string };

type SessionClaims = {
  email?: unknown;
  name?: unknown;
  exp?: number;
  iat?: number;
};

/** 署名済みセッショントークンを発行する */
export async function createSessionToken(
  user: SessionUser,
  secret: string,
  ttlHours: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    email: user.email,
    iat: now,
    exp: now + Math.floor(ttlHours * 3600),
  };
  if (user.name) payload.name = user.name;
  return sign(payload, secret);
}

/** セッショントークンを検証してユーザーを返す。無効・期限切れは null */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionUser | null> {
  try {
    const claims = (await verify(token, secret, "HS256")) as SessionClaims;
    if (typeof claims.email !== "string" || !claims.email) return null;
    return {
      email: claims.email,
      name: typeof claims.name === "string" ? claims.name : undefined,
    };
  } catch {
    return null;
  }
}

/** Cookie ヘッダから 1 個のCookie値を取り出す(middleware/ルート共通) */
export function readCookie(
  header: string | null,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return undefined;
}

/** リクエストの Cookie からセッションユーザーを取り出す(認証ゲートの中核) */
export async function getSessionFromRequest(
  request: Request,
  secret: string,
): Promise<SessionUser | null> {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  return verifySessionToken(token, secret);
}

/** 短命の署名付きペイロード(OAuth の state/PKCE 一時保存に使う) */
export async function signState(
  data: Record<string, unknown>,
  secret: string,
  ttlSeconds = 600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ ...data, iat: now, exp: now + ttlSeconds }, secret);
}

export async function verifyState<T>(
  token: string,
  secret: string,
): Promise<T | null> {
  try {
    return (await verify(token, secret, "HS256")) as T;
  } catch {
    return null;
  }
}
