import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  listCategories,
  resolveGasRegistryConfig,
  type Registry,
} from "./registry";
import { parseProxyTargets, proxyRequest } from "./proxy";
import {
  edgeCache,
  fetchGasRegistry,
  listPortalCategories,
  mergeAutoApps,
  type GasApp,
  type PortalApp,
} from "./gas-registry";
import {
  fetchUserRegistry,
  AppsScriptForbiddenError,
  TokenInvalidError,
} from "./google-registry";
import {
  isAllowed,
  resolveAllowlist,
  type KVNamespace,
} from "./auth/allowlist";
import {
  buildAuthUrl,
  buildConnectUrl,
  exchangeCode,
  exchangeCodeForTokens,
  pkceChallenge,
  randomString,
  refreshAccessToken,
  REGISTRY_SCOPES,
  revokeToken,
  TokenRefreshError,
  type GoogleConfig,
} from "./auth/google";
import { sha256hex } from "./auth/crypto";
import {
  deleteStoredToken,
  isConnected,
  loadStoredToken,
  saveRefreshToken,
} from "./auth/token-store";
import {
  createSessionToken,
  DEFAULT_SESSION_TTL_HOURS,
  getSessionFromRequest,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  signState,
  verifyState,
  type SessionUser,
} from "./auth/session";

export type Env = {
  /** JSON文字列: {"appId": "https://script.google.com/.../exec"} */
  PROXY_TARGETS?: string;
  /** Google OAuth クライアント */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** hd ヒント(任意・UX用。実際の許可判定は許可リストで行う) */
  GOOGLE_HOSTED_DOMAIN?: string;
  /** セッション/state 署名用のHMAC鍵。ローテートで全セッション失効 */
  AUTH_SECRET?: string;
  /** リダイレクトURIの基点を明示上書きしたい場合(通常はリクエストから自動導出) */
  APP_BASE_URL?: string;
  /** セッションTTL(時間)。既定7日 */
  SESSION_TTL_HOURS?: string;
  /** 許可リスト(env ベースライン)。`*` ワイルドカード可 */
  ALLOWED_EMAIL_DOMAINS?: string;
  ALLOWED_EMAILS?: string;
  /** 許可リスト(運用中に追加・失効する分)を置くKV */
  AUTH_KV?: KVNamespace;
  /**
   * プレビュー(pages.dev)で Cloudflare Access のトークンを署名検証するための設定。
   * 設定すると presence チェックから厳密な RS256 署名検証に格上げされる。
   * - CF_ACCESS_TEAM_DOMAIN: "myteam" 等(iss を固定)
   * - CF_ACCESS_AUD: Access アプリの AUD タグ(設定時は aud も固定)
   */
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
};

type AppContext = Context<{ Bindings: Env }>;

/** PROXY_TARGETS 内で GASレジストリのエンドポイントを指すキー名。 */
const REGISTRY_TARGET_KEY = "registry";

function isHttps(c: AppContext): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/** リダイレクトURIの基点。APP_BASE_URL があれば優先、無ければリクエストから導出 */
function baseUrl(c: AppContext): string {
  const override = c.env.APP_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const u = new URL(c.req.url);
  return `${u.protocol}//${u.host}`;
}

/** Google 設定を組み立てる。必須secretが欠けていれば null(未設定) */
function googleConfig(c: AppContext): GoogleConfig | null {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !c.env.AUTH_SECRET) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${baseUrl(c)}/api/auth/callback`,
  };
}

/** 現在のログインユーザー(自前セッション)を返す。無ければ null。 */
async function getUser(c: AppContext): Promise<SessionUser | null> {
  const secret = c.env.AUTH_SECRET;
  if (!secret) return null;
  return getSessionFromRequest(c.req.raw, secret);
}

/**
 * 本人権限で GAS 一覧を取得する(アクセストークンへリフレッシュ→Drive/Apps Script API)。
 * 結果は Cache API でユーザーごとに数分キャッシュし、GAS API への多数の呼び出しを抑える。
 */
async function fetchUserRegistryCached(
  cfg: GoogleConfig,
  email: string,
  refreshToken: string,
): Promise<GasApp[]> {
  const cache = edgeCache();
  const cacheKey = new Request(
    `https://portal.internal/registry/user/${await sha256hex(email)}`,
  );
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return (await hit.json()) as GasApp[];
  }
  const { accessToken } = await refreshAccessToken(cfg, refreshToken);
  const apps = await fetchUserRegistry(accessToken);
  if (cache) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(apps), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "max-age=300",
        },
      }),
    );
  }
  return apps;
}

/** ログイン後の戻り先。同一オリジンの絶対パスのみ許可(オープンリダイレクト防止) */
function sanitizeRedirect(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function sessionTtlHours(env: Env): number {
  const n = env.SESSION_TTL_HOURS ? Number(env.SESSION_TTL_HOURS) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_TTL_HOURS;
}

function cookieOptions(secure: boolean, maxAge: number) {
  return {
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}

function forbiddenPage(email: string): string {
  const safe = email.replace(/[<>&]/g, "");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>アクセス権がありません</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7}</style>
</head><body>
<h1>アクセス権がありません</h1>
<p><strong>${safe}</strong> はこのポータルの許可リストに登録されていません。</p>
<p>心当たりがない場合は管理者にご連絡ください。別のアカウントで試すには
<a href="/api/auth/login">こちらから再ログイン</a>してください。</p>
</body></html>`;
}

/**
 * 連携フローのコールバック処理。追加スコープ付きの認可コードをトークン交換し、
 * リフレッシュトークンを暗号化して KV に保管する。
 */
async function handleConnectCallback(
  c: AppContext,
  cfg: GoogleConfig,
  secret: string,
  code: string,
  saved: { verifier: string; redirect: string; email?: string },
): Promise<Response> {
  const kv = c.env.AUTH_KV;
  if (!kv) return c.text("トークン保管用の AUTH_KV が未設定です", 503);

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(cfg, code, saved.verifier);
  } catch {
    return c.text("Googleトークン交換に失敗しました", 502);
  }
  if (!tokens.identity.emailVerified) {
    return c.text("メールアドレスが未確認のGoogleアカウントです", 403);
  }
  const allowlist = await resolveAllowlist(c.env);
  if (!isAllowed(tokens.identity.email, allowlist)) {
    return c.html(forbiddenPage(tokens.identity.email), 403);
  }
  // 連携開始時のログインアカウントと一致していること(別アカウントの取り違え防止)
  if (
    saved.email &&
    saved.email.toLowerCase() !== tokens.identity.email.toLowerCase()
  ) {
    return c.text(
      "連携しようとしたGoogleアカウントが、ログイン中のアカウントと一致しません。同じアカウントで連携してください。",
      400,
    );
  }
  if (!tokens.refreshToken) {
    return c.text(
      "リフレッシュトークンを取得できませんでした。Googleアカウントのアクセス権限画面 (https://myaccount.google.com/permissions) で本アプリの許可を一度取り消してから、再度連携してください。",
      400,
    );
  }
  await saveRefreshToken(kv, secret, tokens.identity.email, {
    refreshToken: tokens.refreshToken,
    scope: tokens.scope,
    connectedAt: Date.now(),
  });
  return c.redirect(sanitizeRedirect(saved.redirect));
}

export function createApp(registry: Registry) {
  const app = new Hono<{ Bindings: Env }>();

  // ---- 認証 (Google OAuth) ----

  // 1. ログイン開始: state/PKCE を発行し Google の同意画面へ
  app.get("/api/auth/login", async (c) => {
    const cfg = googleConfig(c);
    if (!cfg) {
      return c.text(
        "認証が未設定です (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / AUTH_SECRET を設定してください)",
        503,
      );
    }
    const secret = c.env.AUTH_SECRET!;
    const state = randomString(24);
    const verifier = randomString(32);
    const challenge = await pkceChallenge(verifier);
    const redirect = sanitizeRedirect(c.req.query("redirect"));

    const stateToken = await signState({ state, verifier, redirect }, secret);
    setCookie(c, OAUTH_COOKIE, stateToken, cookieOptions(isHttps(c), 600));

    return c.redirect(
      buildAuthUrl(cfg, {
        state,
        codeChallenge: challenge,
        hostedDomain: c.env.GOOGLE_HOSTED_DOMAIN,
      }),
    );
  });

  // 2. コールバック: code をトークン交換 → 許可判定 → セッション発行
  app.get("/api/auth/callback", async (c) => {
    const cfg = googleConfig(c);
    const secret = c.env.AUTH_SECRET;
    if (!cfg || !secret) return c.text("認証が未設定です", 503);

    const error = c.req.query("error");
    if (error) {
      return c.text(`Googleログインがキャンセルされました: ${error}`, 400);
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    const stateCookie = getCookie(c, OAUTH_COOKIE);
    deleteCookie(c, OAUTH_COOKIE, { path: "/" });
    if (!code || !state || !stateCookie) {
      return c.text("不正なコールバックです", 400);
    }

    const saved = await verifyState<{
      state: string;
      verifier: string;
      redirect: string;
      flow?: string;
      email?: string;
    }>(stateCookie, secret);
    if (!saved || saved.state !== state) {
      return c.text(
        "stateが一致しません (ログインの有効期限切れの可能性があります。もう一度お試しください)",
        400,
      );
    }

    // 連携フロー(Drive スコープの追加同意): リフレッシュトークンを暗号化保管する
    if (saved.flow === "connect") {
      return handleConnectCallback(c, cfg, secret, code, saved);
    }

    let identity;
    try {
      identity = await exchangeCode(cfg, code, saved.verifier);
    } catch {
      return c.text("Googleトークン交換に失敗しました", 502);
    }
    if (!identity.emailVerified) {
      return c.text("メールアドレスが未確認のGoogleアカウントです", 403);
    }

    const allowlist = await resolveAllowlist(c.env);
    if (!isAllowed(identity.email, allowlist)) {
      return c.html(forbiddenPage(identity.email), 403);
    }

    const ttlHours = sessionTtlHours(c.env);
    const token = await createSessionToken(
      { email: identity.email, name: identity.name },
      secret,
      ttlHours,
    );
    setCookie(
      c,
      SESSION_COOKIE,
      token,
      cookieOptions(isHttps(c), Math.floor(ttlHours * 3600)),
    );
    return c.redirect(sanitizeRedirect(saved.redirect));
  });

  // 3. ログアウト
  app.get("/api/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.html(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログアウトしました</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7}</style>
</head><body><h1>ログアウトしました</h1>
<p><a href="/api/auth/login">もう一度ログイン</a></p></body></html>`,
    );
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // 4. 現在のログインユーザー(画面のヘッダ表示用)
  app.get("/api/me", async (c) => {
    const secret = c.env.AUTH_SECRET;
    if (secret) {
      const user = await getSessionFromRequest(c.req.raw, secret);
      if (user) {
        return c.json({
          authenticated: true,
          email: user.email,
          name: user.name ?? null,
        });
      }
    }
    // Cloudflare Access 保護下(プレビュー)では Access が身元ヘッダを注入する
    const accessEmail = c.req.header("Cf-Access-Authenticated-User-Email");
    if (accessEmail) {
      return c.json({ authenticated: true, email: accessEmail, name: null });
    }
    return c.json({ authenticated: false }, 401);
  });

  // ---- 台帳・プロキシ (認証ゲートは functions/_middleware.ts が担当) ----

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/apps", (c) =>
    c.json({
      apps: registry.apps,
      categories: listCategories(registry),
    }),
  );

  // Phase 2: 手動台帳(apps.json)と、GAS自動取得分をマージして返す。
  //
  // 取得元は次の優先順位:
  //   1. ユーザーモード(方式B): 本人が Google Drive 連携済みなら、本人の権限で
  //      「その人がアクセスできる GAS」だけを列挙する(per-user アクセス制御)。
  //   2. 共有モード: PROXY_TARGETS["registry"] の共有レジストリGASをプロキシ。
  //   3. 手動のみ: どちらも無ければ apps.json だけを返す。
  // いずれの失敗時も手動分は必ず返し、画面を壊さない。
  app.get("/api/registry", async (c) => {
    const config = resolveGasRegistryConfig(registry);

    const mergedResponse = (
      autoApps: GasApp[],
      extra: Record<string, unknown>,
    ): Response => {
      const merged = mergeAutoApps(registry.apps, autoApps, config);
      const autoCount = merged.filter((a) => a.auto).length;
      return c.json({
        apps: merged,
        categories: listPortalCategories(merged),
        source: { manual: merged.length - autoCount, auto: autoCount, ...extra },
      });
    };
    const manualOnly = (extra: Record<string, unknown> = {}): Response =>
      mergedResponse([], extra);

    // ---- 1. ユーザーモード(本人権限) ----
    const user = await getUser(c);
    const secret = c.env.AUTH_SECRET;
    const cfg = googleConfig(c);
    if (user && secret && cfg && c.env.AUTH_KV) {
      const stored = await loadStoredToken(c.env.AUTH_KV, secret, user.email);
      if (stored) {
        try {
          const autoApps = await fetchUserRegistryCached(
            cfg,
            user.email,
            stored.refreshToken,
          );
          return mergedResponse(autoApps, { mode: "user" });
        } catch (err) {
          // 連携が失効(取消・無効)していたら自動で連携解除して手動へフォールバック
          const expired =
            err instanceof TokenInvalidError ||
            (err instanceof TokenRefreshError && err.isInvalidGrant);
          if (expired) {
            await deleteStoredToken(c.env.AUTH_KV, user.email);
            return manualOnly({ mode: "user", userAuthExpired: true });
          }
          if (err instanceof AppsScriptForbiddenError) {
            // Apps Script API 未有効化のヒント(利用者が有効化すれば解消)
            return manualOnly({ mode: "user", appsScriptApiDisabled: true });
          }
          return manualOnly({
            mode: "user",
            stale: true,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ---- 2. 共有モード(PROXY_TARGETS["registry"]) ----
    let registryUrl: string | undefined;
    try {
      registryUrl = parseProxyTargets(c.env.PROXY_TARGETS)[REGISTRY_TARGET_KEY];
    } catch {
      return manualOnly({ mode: "manual", registryConfigured: false });
    }
    if (!registryUrl) {
      return manualOnly({ mode: "manual", registryConfigured: false });
    }
    try {
      const { apps: autoApps } = await fetchGasRegistry(registryUrl);
      return mergedResponse(autoApps, {
        mode: "shared",
        registryConfigured: true,
      });
    } catch (err) {
      return manualOnly({
        mode: "shared",
        registryConfigured: true,
        stale: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Phase 2 (方式B): 本人の Google Drive 連携。ログイン中ユーザーだけが開始でき、
  // 追加スコープ(drive.metadata.readonly / script.deployments.readonly)に同意すると
  // リフレッシュトークンを暗号化保管する。
  app.get("/api/registry/connect", async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: "認証が必要です" }, 401);
    const cfg = googleConfig(c);
    if (!cfg) return c.text("認証が未設定です", 503);
    if (!c.env.AUTH_KV) {
      return c.text("トークン保管用の AUTH_KV が未設定です", 503);
    }
    const secret = c.env.AUTH_SECRET!;
    const state = randomString(24);
    const verifier = randomString(32);
    const challenge = await pkceChallenge(verifier);
    const redirect = sanitizeRedirect(c.req.query("redirect"));

    const stateToken = await signState(
      { state, verifier, redirect, flow: "connect", email: user.email },
      secret,
    );
    setCookie(c, OAUTH_COOKIE, stateToken, cookieOptions(isHttps(c), 600));

    return c.redirect(
      buildConnectUrl(cfg, {
        state,
        codeChallenge: challenge,
        scopes: REGISTRY_SCOPES,
        loginHint: user.email,
        hostedDomain: c.env.GOOGLE_HOSTED_DOMAIN,
      }),
    );
  });

  // 連携状態の取得(画面の連携ボタン表示用)
  app.get("/api/registry/status", async (c) => {
    const user = await getUser(c);
    const available = !!(googleConfig(c) && c.env.AUTH_KV);
    let connected = false;
    if (user && c.env.AUTH_KV) {
      connected = await isConnected(c.env.AUTH_KV, user.email);
    }
    return c.json({ authenticated: !!user, available, connected });
  });

  // 連携解除: 保管トークンを削除し、Google 側でも失効させる
  app.post("/api/registry/disconnect", async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: "認証が必要です" }, 401);
    const kv = c.env.AUTH_KV;
    if (!kv) return c.json({ ok: true });
    const secret = c.env.AUTH_SECRET;
    if (secret) {
      const stored = await loadStoredToken(kv, secret, user.email);
      if (stored?.refreshToken) await revokeToken(stored.refreshToken);
    }
    await deleteStoredToken(kv, user.email);
    return c.json({ ok: true });
  });

  app.all("/api/proxy/:id", async (c) => {
    let targets;
    try {
      targets = parseProxyTargets(c.env.PROXY_TARGETS);
    } catch {
      return c.json({ error: "PROXY_TARGETS の設定が不正です" }, 500);
    }
    return proxyRequest(targets, c.req.param("id"), c.req.raw);
  });

  // このHonoアプリはPages Function (functions/api/[[route]].ts) として
  // /api/* だけを担当する。画面などの静的アセットはPagesが直接配信するため、
  // ここでは未定義のAPIパスを404で返すだけでよい。
  app.all("*", (c) => c.json({ error: "not found" }, 404));

  return app;
}
