/**
 * Clerk 認証(サーバー側)ラッパー。
 *
 * 認証は Clerk に一本化している。ブラウザは Clerk の hosted なサインイン画面
 * (Account Portal)でログインし、Clerk が発行するセッションJWT(`__session` Cookie)を
 * 持って本サイトに戻る。サーバー(Pages Functions)は `@clerk/backend` の
 * `authenticateRequest()` でそのセッションを検証する。従来の自前 Google OAuth
 * (state/PKCE/自前セッション)や Cloudflare Access(Zero Trust)の使い分けは廃止した。
 *
 * - 検証は JWKS(または CLERK_JWT_KEY による networkless 検証)で行う。ClerkClient は
 *   env が同一なら isolate 内で使い回し、JWKS 取得を毎リクエストで繰り返さない。
 * - `status` は "signed-in" / "signed-out" / "handshake" の3値。handshake は
 *   「Clerk 側にはセッションがあるが本ドメインの `__session` Cookie がまだ無い」状態で、
 *   Clerk が返すヘッダ(Set-Cookie + Location)をそのまま返して Cookie を確定させる。
 * - 許可リスト照合に使うメールは、まずセッションJWTの `email` クレームから取り、
 *   無ければ Backend API(getUser)にフォールバックする(claim を設定しておけば毎回の
 *   API 呼び出しを避けられる)。
 * - Phase 2(本人権限でのGAS列挙)用の Google アクセストークンは、Clerk の Google 連携
 *   から Backend API(getUserOauthAccessToken)で取得する。リフレッシュは Clerk が担う。
 */
import { createClerkClient, type ClerkClient } from "@clerk/backend";

export type ClerkEnv = {
  /** Clerk の Publishable key(pk_test_… / pk_live_…)。フロント/バックエンド共通の識別子 */
  CLERK_PUBLISHABLE_KEY?: string;
  /** Clerk の Secret key(sk_test_… / sk_live_…)。Backend API 呼び出しに必須 */
  CLERK_SECRET_KEY?: string;
  /**
   * (任意)Clerk インスタンスの JWT 検証用公開鍵(PEM)。設定すると JWKS 取得なしの
   * networkless 検証になり、レイテンシと外部依存を減らせる。未設定なら JWKS を使う。
   */
  CLERK_JWT_KEY?: string;
  /**
   * (任意)`azp`(authorized party)として許可するオリジン。カンマ/空白区切り。
   * 設定すると別オリジンからのトークン持ち込みを弾ける。例
   * `https://portal.example.co.jp,https://inhouse-portal.pages.dev`。
   */
  CLERK_AUTHORIZED_PARTIES?: string;
};

/** env → ClerkClient。未設定(キー欠落)なら null。env 同一なら同じインスタンスを返す。 */
let cachedClient: { key: string; client: ClerkClient } | null = null;
export function getClerkClient(env: ClerkEnv): ClerkClient | null {
  const secretKey = env.CLERK_SECRET_KEY;
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) return null;
  const jwtKey = env.CLERK_JWT_KEY;
  const key = `${secretKey}|${publishableKey}|${jwtKey ?? ""}`;
  if (cachedClient && cachedClient.key === key) return cachedClient.client;
  const client = createClerkClient({ secretKey, publishableKey, jwtKey });
  cachedClient = { key, client };
  return client;
}

/** テスト用: クライアントキャッシュを消す。 */
export function resetClerkClientCache(): void {
  cachedClient = null;
}

/** CLERK_AUTHORIZED_PARTIES を配列に。未設定なら undefined。 */
export function authorizedParties(env: ClerkEnv): string[] | undefined {
  const raw = env.CLERK_AUTHORIZED_PARTIES?.trim();
  if (!raw) return undefined;
  const parties = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return parties.length ? parties : undefined;
}

/** サインイン中ユーザーのメールを解決する(claim 優先、無ければ Backend API)。 */
export async function resolveEmail(
  client: ClerkClient,
  sessionClaims: Record<string, unknown> | null | undefined,
  userId: string,
): Promise<string | undefined> {
  const claim = sessionClaims?.email;
  if (typeof claim === "string" && claim) return claim;
  try {
    const user = await client.users.getUser(userId);
    const primary = user.emailAddresses.find(
      (e) => e.id === user.primaryEmailAddressId,
    );
    return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
  } catch {
    return undefined;
  }
}

/** Clerk の Google 連携からアクセストークンを取得する。無ければ null。 */
export async function getGoogleAccessToken(
  client: ClerkClient,
  userId: string,
): Promise<string | null> {
  try {
    const res = await client.users.getUserOauthAccessToken(userId, "google");
    const token = res.data?.[0]?.token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

export type ClerkAuth =
  | { configured: false }
  | {
      configured: true;
      status: "signed-in";
      client: ClerkClient;
      userId: string;
      email?: string;
      headers: Headers;
    }
  | { configured: true; status: "handshake"; headers: Headers }
  | {
      configured: true;
      status: "signed-out";
      signInUrl: string;
      headers: Headers;
    };

/**
 * リクエストの Clerk セッションを検証して正規化した結果を返す。
 * Clerk が未設定(キー欠落)なら `{ configured: false }`。
 */
export async function authenticate(
  env: ClerkEnv,
  request: Request,
): Promise<ClerkAuth> {
  const client = getClerkClient(env);
  if (!client) return { configured: false };

  const requestState = await client.authenticateRequest(request, {
    authorizedParties: authorizedParties(env),
    jwtKey: env.CLERK_JWT_KEY,
  });

  if (requestState.status === "handshake") {
    return { configured: true, status: "handshake", headers: requestState.headers };
  }
  if (requestState.isSignedIn) {
    const auth = requestState.toAuth();
    const email = await resolveEmail(
      client,
      auth.sessionClaims as unknown as Record<string, unknown>,
      auth.userId,
    );
    return {
      configured: true,
      status: "signed-in",
      client,
      userId: auth.userId,
      email,
      headers: requestState.headers,
    };
  }
  return {
    configured: true,
    status: "signed-out",
    signInUrl: requestState.signInUrl,
    headers: requestState.headers,
  };
}
