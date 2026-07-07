import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { listCategories, type Registry } from "./registry";
import { parseProxyTargets, proxyRequest } from "./proxy";
import {
  isAllowed,
  resolveAllowlist,
  type KVNamespace,
} from "./auth/allowlist";
import {
  buildAuthUrl,
  exchangeCode,
  pkceChallenge,
  randomString,
  type GoogleConfig,
} from "./auth/google";
import {
  createSessionToken,
  DEFAULT_SESSION_TTL_HOURS,
  getSessionFromRequest,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  signState,
  verifyState,
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
    }>(stateCookie, secret);
    if (!saved || saved.state !== state) {
      return c.text(
        "stateが一致しません (ログインの有効期限切れの可能性があります。もう一度お試しください)",
        400,
      );
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
