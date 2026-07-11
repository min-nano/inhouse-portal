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
  listPortalCategories,
  mergeAutoApps,
  type GasApp,
  type PortalApp,
} from "./gas-registry";
import {
  fetchUserRegistry,
  AppsScriptForbiddenError,
  TokenInvalidError,
  type UserRegistry,
} from "./google-registry";
import {
  isAllowed,
  resolveAllowlist,
  type KVNamespace,
} from "./auth/allowlist";
import {
  buildAuthUrl,
  exchangeCode,
  exchangeCodeForTokens,
  pkceChallenge,
  randomString,
  refreshAccessToken,
  REGISTRY_SCOPES,
  TokenRefreshError,
  type GoogleConfig,
} from "./auth/google";
import { sha256hex } from "./auth/crypto";
import {
  deleteStoredToken,
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
  /** 許可リスト(運用中に追加・失効する分)を置くKV。許可リスト運用専用。 */
  AUTH_KV?: KVNamespace;
  /**
   * 方式B(本人権限での GAS 自動列挙)用のリフレッシュトークン保管先KV。
   * **このKVをバインドすること自体が方式B利用の opt-in** となる(バインド + Google OAuth
   * 設定が揃うと有効化)。許可リスト用の AUTH_KV とは分離し、許可リスト目的で KV を
   * バインドしただけで sensitive スコープ要求やトークン保管が発動しないようにする。
   * 有効化前に OAuth 同意画面へ当該スコープ(drive.metadata.readonly /
   * script.deployments.readonly)を追加しておくこと(未追加だと invalid_scope で失敗)。
   */
  REGISTRY_KV?: KVNamespace;
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

/**
 * 方式B(本人権限での GAS 自動列挙)が有効かどうか。有効時はログインで Drive スコープを
 * 要求しリフレッシュトークンを保管する。**専用フラグは持たず、トークン保管用の REGISTRY_KV
 * をバインドすること自体を opt-in とする**(REGISTRY_KV + Google 設定が揃えば有効)。
 * 許可リスト用の AUTH_KV とは分離しているため、許可リスト目的で KV をバインドしただけでは
 * 方式Bは起動しない。有効化前に OAuth 同意画面へ当該スコープを追加しておくこと。
 */
function registryLoginEnabled(c: AppContext): boolean {
  return !!c.env.REGISTRY_KV && googleConfig(c) !== null;
}

/** 現在のログインユーザー(自前セッション)を返す。無ければ null。 */
async function getUser(c: AppContext): Promise<SessionUser | null> {
  const secret = c.env.AUTH_SECRET;
  if (!secret) return null;
  return getSessionFromRequest(c.req.raw, secret);
}

/** Cloudflare 実行環境の `caches.default`(あれば)を取り出す。テスト環境では undefined。 */
function edgeCache(): Cache | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { default?: Cache }).default;
}

/**
 * 本人権限で GAS 一覧を取得する(アクセストークンへリフレッシュ→Drive/Apps Script API)。
 * 結果は Cache API でユーザーごとに数分キャッシュし、GAS API への多数の呼び出しを抑える。
 */
async function fetchUserRegistryCached(
  cfg: GoogleConfig,
  email: string,
  refreshToken: string,
): Promise<UserRegistry> {
  const cache = edgeCache();
  // token-store と同じ正規化(trim+lower)でキーを揃える
  const cacheKey = new Request(
    `https://portal.internal/registry/user/${await sha256hex(
      email.trim().toLowerCase(),
    )}`,
  );
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return (await hit.json()) as UserRegistry;
  }
  const { accessToken } = await refreshAccessToken(cfg, refreshToken);
  const result = await fetchUserRegistry(accessToken);
  if (cache) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(result), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "max-age=300",
        },
      }),
    );
  }
  return result;
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

    // 方式B有効時は、ログインの同意でDriveスコープも要求し refresh token を得る。
    // ?reconnect=1 のときは prompt=consent を付け、トークン喪失後でも refresh token を
    // 確実に再発行させる(通常ログインは select_account で毎回の同意を避ける)。
    const withRegistry = registryLoginEnabled(c);
    const reconnect = c.req.query("reconnect") === "1";
    return c.redirect(
      buildAuthUrl(cfg, {
        state,
        codeChallenge: challenge,
        hostedDomain: c.env.GOOGLE_HOSTED_DOMAIN,
        scopes: withRegistry ? REGISTRY_SCOPES : undefined,
        accessType: withRegistry ? "offline" : "online",
        prompt: withRegistry && reconnect ? "consent" : undefined,
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
    }>(stateCookie, secret);
    if (!saved || saved.state !== state) {
      return c.text(
        "stateが一致しません (ログインの有効期限切れの可能性があります。もう一度お試しください)",
        400,
      );
    }

    // 方式B有効時は refresh token も受け取り、後で暗号化保管する
    const withRegistry = registryLoginEnabled(c);
    let identity;
    let refreshToken: string | undefined;
    let grantedScope: string | undefined;
    try {
      if (withRegistry) {
        const tokens = await exchangeCodeForTokens(cfg, code, saved.verifier);
        identity = tokens.identity;
        refreshToken = tokens.refreshToken;
        grantedScope = tokens.scope;
      } else {
        identity = await exchangeCode(cfg, code, saved.verifier);
      }
    } catch {
      return c.text("Googleトークン交換に失敗しました", 502);
    }
    if (!identity.emailVerified) {
      return c.text("メールアドレスが未確認のGoogleアカウントです", 403);
    }

    const allowlist = await resolveAllowlist(c.env, secret);
    if (!(await isAllowed(identity.email, allowlist, secret))) {
      return c.html(forbiddenPage(identity.email), 403);
    }

    // 本人権限でのGAS列挙用に、リフレッシュトークンを暗号化して保管する。
    // (返るのは初回同意時のみ。既に保管済みなら再取得不要なので無い場合は据え置き)
    // granular consent で Drive/Script スコープが外された場合は保管しない。保管すると
    // /api/registry が毎回失敗し「一時的に失敗」を出し続けるため、共有/手動へフォールバックさせる。
    const grantedList = grantedScope?.split(" ") ?? [];
    const hasRegistryScopes = REGISTRY_SCOPES.every((s) =>
      grantedList.includes(s),
    );
    if (withRegistry && c.env.REGISTRY_KV && refreshToken && hasRegistryScopes) {
      await saveRefreshToken(c.env.REGISTRY_KV, secret, identity.email, {
        refreshToken,
        scope: grantedScope,
        connectedAt: Date.now(),
      });
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
  //      「その人がアクセスできる GAS」(共有ドライブ内含む)だけを列挙する。
  //   2. 手動のみ: 連携が無ければ apps.json だけを返す。
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
    if (user && secret && cfg && c.env.REGISTRY_KV) {
      const stored = await loadStoredToken(c.env.REGISTRY_KV, secret, user.email);
      if (stored) {
        try {
          const { apps: autoApps, incompleteSearch } =
            await fetchUserRegistryCached(cfg, user.email, stored.refreshToken);
          return mergedResponse(autoApps, {
            mode: "user",
            // 共有ドライブ検索が不完全だった場合は「一部欠落の可能性」を画面へ伝える
            ...(incompleteSearch ? { incomplete: true } : {}),
          });
        } catch (err) {
          // 連携が失効(取消・無効)していたら自動で連携解除して手動へフォールバック
          const expired =
            err instanceof TokenInvalidError ||
            (err instanceof TokenRefreshError && err.isInvalidGrant);
          if (expired) {
            await deleteStoredToken(c.env.REGISTRY_KV, secret, user.email);
            return manualOnly({ mode: "user", userAuthExpired: true });
          }
          if (err instanceof AppsScriptForbiddenError) {
            // Apps Script API 未有効化のヒント(利用者が有効化すれば解消)
            return manualOnly({ mode: "user", appsScriptApiDisabled: true });
          }
          // 詳細はサーバーログのみ(ZodError等の内部詳細をクライアントに出さない)
          console.warn("registry user mode failed:", err);
          return manualOnly({ mode: "user", stale: true });
        }
      }
    }

    // ---- 2. 手動のみ(方式B未連携) ----
    return manualOnly({ mode: "manual" });
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
