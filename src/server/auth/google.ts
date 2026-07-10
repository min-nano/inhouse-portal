/**
 * Google OAuth 2.0 (OIDC / authorization code + PKCE)。
 *
 * 認可コードは client_secret 付きでサーバー間(TLS)交換するため、返ってくる
 * id_token は Google から直接受け取った信頼できるトークンとして扱い、
 * クレーム(iss/aud/exp/email/email_verified)の検証のみ行う
 * (JWKS 署名検証は belt-and-suspenders。必要になれば追加する)。
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const VALID_ISS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

/**
 * GASレジストリ(本人権限での自動列挙)に必要な最小スコープ。
 * - drive.metadata.readonly: GASプロジェクト(script mimeType)の一覧(メタデータのみ)
 * - script.deployments.readonly: 各プロジェクトのデプロイ(WebアプリURL)の参照
 * これらは Google の「センシティブ」スコープ。内部(Internal)アプリなら審査不要。
 */
export const REGISTRY_SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/script.deployments.readonly",
];

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GoogleIdentity = {
  email: string;
  emailVerified: boolean;
  name?: string;
  hd?: string;
};

function base64urlFromBytes(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64url(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** ランダム文字列(state / PKCE code_verifier 用)。base64url なのでPKCEの許容文字に収まる */
export function randomString(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return base64urlFromBytes(arr);
}

/** PKCE code_challenge (S256) を生成 */
export async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64urlFromBytes(new Uint8Array(digest));
}

/**
 * Google の同意画面へのリダイレクトURLを組み立てる。
 * `scopes` を渡すと openid/email/profile に追加し、`accessType: "offline"` で
 * リフレッシュトークンを要求する(初回同意時のみ返る)。
 */
export function buildAuthUrl(
  cfg: GoogleConfig,
  opts: {
    state: string;
    codeChallenge: string;
    hostedDomain?: string;
    scopes?: string[];
    accessType?: "online" | "offline";
  },
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    ["openid", "email", "profile", ...(opts.scopes ?? [])].join(" "),
  );
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  if (opts.accessType === "offline") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
  }
  if (opts.hostedDomain) url.searchParams.set("hd", opts.hostedDomain);
  return url.toString();
}

/** id_token(JWT)のペイロードを検証して身元情報を取り出す */
export function parseIdToken(
  idToken: string,
  expectedAud: string,
): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const payload = JSON.parse(decodeBase64url(parts[1]!)) as Record<
    string,
    unknown
  >;

  if (typeof payload.iss !== "string" || !VALID_ISS.has(payload.iss)) {
    throw new Error("invalid iss");
  }
  if (payload.aud !== expectedAud) throw new Error("invalid aud");
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    throw new Error("id_token expired");
  }
  if (typeof payload.email !== "string" || !payload.email) {
    throw new Error("email missing");
  }

  return {
    email: payload.email,
    emailVerified:
      payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" ? payload.name : undefined,
    hd: typeof payload.hd === "string" ? payload.hd : undefined,
  };
}

/** 認可コードをトークン交換し、身元情報を返す */
export async function exchangeCode(
  cfg: GoogleConfig,
  code: string,
  codeVerifier: string,
): Promise<GoogleIdentity> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as { id_token?: unknown };
  if (typeof data.id_token !== "string") {
    throw new Error("id_token missing in token response");
  }
  return parseIdToken(data.id_token, cfg.clientId);
}

export type GoogleTokens = {
  identity: GoogleIdentity;
  accessToken: string;
  /** access_type=offline のとき返る長期トークン。無い場合もある。 */
  refreshToken?: string;
  /** access token の有効秒数 */
  expiresIn: number;
  /** 実際に付与されたスコープ(スペース区切り) */
  scope?: string;
};

/**
 * 認可コードをトークン交換し、アクセス/リフレッシュトークン一式と身元を返す。
 * インクリメンタル認可(連携フロー)で使う。
 */
export async function exchangeCodeForTokens(
  cfg: GoogleConfig,
  code: string,
  codeVerifier: string,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    id_token?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof data.id_token !== "string") {
    throw new Error("id_token missing in token response");
  }
  if (typeof data.access_token !== "string") {
    throw new Error("access_token missing in token response");
  }
  return {
    identity: parseIdToken(data.id_token, cfg.clientId),
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 3600,
    scope: typeof data.scope === "string" ? data.scope : undefined,
  };
}

/** リフレッシュ失敗。status が 4xx なら連携失効(取消/無効)、5xx なら一時障害。 */
export class TokenRefreshError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`token refresh failed: ${status}`);
    this.name = "TokenRefreshError";
    this.status = status;
  }
  /** 恒久的な失効(連携解除すべき)か。 */
  get isInvalidGrant(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/** リフレッシュトークンから新しいアクセストークンを得る。 */
export async function refreshAccessToken(
  cfg: GoogleConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    // 400/401 は連携失効(ユーザーが取消 or トークン無効)。呼び出し側で連携解除する。
    throw new TokenRefreshError(res.status);
  }
  const data = (await res.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof data.access_token !== "string") {
    throw new Error("access_token missing in refresh response");
  }
  return {
    accessToken: data.access_token,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : 3600,
  };
}

