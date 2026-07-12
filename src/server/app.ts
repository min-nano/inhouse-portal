import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie } from "hono/cookie";
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
} from "./gas-registry";
import {
  fetchUserRegistry,
  AppsScriptForbiddenError,
  TokenInvalidError,
  type UserRegistry,
} from "./google-registry";
import {
  authenticate,
  authorizedParties,
  getClerkClient,
  getGoogleAccessToken,
  resolveEmail,
} from "./auth/clerk";
import { sha256hex } from "./auth/crypto";

export type Env = {
  /** JSON文字列: {"appId": "https://script.google.com/.../exec"} */
  PROXY_TARGETS?: string;
  /**
   * Clerk のキー。認証・許可(誰がサインインできるか)はすべて Clerk で管理する
   * (Restrictions の Allowlist / Invitations)。アプリ側の許可リストは持たない。
   */
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_SECRET_KEY?: string;
  /** (任意)networkless 検証用の JWT 公開鍵(PEM) */
  CLERK_JWT_KEY?: string;
  /** (任意)azp として許可するオリジン(カンマ/空白区切り) */
  CLERK_AUTHORIZED_PARTIES?: string;
};

type AppContext = Context<{ Bindings: Env }>;

/** Cloudflare 実行環境の `caches.default`(あれば)を取り出す。テスト環境では undefined。 */
function edgeCache(): Cache | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { default?: Cache }).default;
}

/**
 * 本人権限で GAS 一覧を取得する(Clerk 経由の Google アクセストークンで Drive/Apps Script
 * API を直接叩く)。結果は Cache API でユーザーごとに数分キャッシュし、GAS API への
 * 多数の呼び出しを抑える。
 */
async function fetchUserRegistryCached(
  userId: string,
  accessToken: string,
): Promise<UserRegistry> {
  const cache = edgeCache();
  const cacheKey = new Request(
    `https://portal.internal/registry/user/${await sha256hex(userId)}`,
  );
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return (await hit.json()) as UserRegistry;
  }
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

export function createApp(registry: Registry) {
  const app = new Hono<{ Bindings: Env }>();

  // ---- 認証 (Clerk) ----
  //
  // ログイン画面は Clerk 側(Account Portal)に委ねる。未サインインの画面遷移は
  // functions/_middleware.ts が Clerk のサインインURLへ 302 する。ここではログアウトと
  // 現在ユーザーの取得だけを担う。

  // ログアウト: Clerk セッションを失効させ、セッション Cookie を消す。
  app.get("/api/auth/logout", async (c) => {
    const client = getClerkClient(c.env);
    if (client) {
      try {
        const rs = await client.authenticateRequest(c.req.raw, {
          authorizedParties: authorizedParties(c.env),
          jwtKey: c.env.CLERK_JWT_KEY,
        });
        if (rs.isSignedIn) {
          const { sessionId } = rs.toAuth();
          if (sessionId) await client.sessions.revokeSession(sessionId);
        }
      } catch {
        // ベストエフォート(失効に失敗しても Cookie は消す)
      }
    }
    deleteCookie(c, "__session", { path: "/" });
    return c.html(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログアウトしました</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7}</style>
</head><body><h1>ログアウトしました</h1>
<p><a href="/">もう一度ログイン</a></p></body></html>`,
    );
  });

  app.post("/api/auth/logout", async (c) => {
    const client = getClerkClient(c.env);
    if (client) {
      try {
        const rs = await client.authenticateRequest(c.req.raw, {
          authorizedParties: authorizedParties(c.env),
          jwtKey: c.env.CLERK_JWT_KEY,
        });
        if (rs.isSignedIn) {
          const { sessionId } = rs.toAuth();
          if (sessionId) await client.sessions.revokeSession(sessionId);
        }
      } catch {
        // best effort
      }
    }
    deleteCookie(c, "__session", { path: "/" });
    return c.json({ ok: true });
  });

  // 現在のログインユーザー(画面のヘッダ表示用)
  app.get("/api/me", async (c) => {
    const auth = await authenticate(c.env, c.req.raw);
    if (auth.configured && auth.status === "signed-in") {
      const email = await resolveEmail(
        auth.client,
        auth.sessionClaims,
        auth.userId,
      );
      return c.json({
        authenticated: true,
        email: email ?? null,
        name: null,
      });
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
  //   1. ユーザーモード(方式B): サインイン中の本人が Clerk で Google を連携していれば、
  //      Clerk から得た本人の Google アクセストークンで「その人がアクセスできる GAS」
  //      (共有ドライブ内含む)だけを列挙する。
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
    const auth = await authenticate(c.env, c.req.raw);
    if (auth.configured && auth.status === "signed-in") {
      const accessToken = await getGoogleAccessToken(auth.client, auth.userId);
      if (accessToken) {
        try {
          const { apps: autoApps, incompleteSearch } =
            await fetchUserRegistryCached(auth.userId, accessToken);
          return mergedResponse(autoApps, {
            mode: "user",
            // 共有ドライブ検索が不完全だった場合は「一部欠落の可能性」を画面へ伝える
            ...(incompleteSearch ? { incomplete: true } : {}),
          });
        } catch (err) {
          // トークン失効(Google 側で取消/失効)。Clerk 側で再連携すれば復旧する。
          if (err instanceof TokenInvalidError) {
            return manualOnly({ mode: "user", userAuthExpired: true });
          }
          if (err instanceof AppsScriptForbiddenError) {
            // Apps Script API 未有効化のヒント(利用者が有効化すれば解消)
            return manualOnly({ mode: "user", appsScriptApiDisabled: true });
          }
          // 詳細はサーバーログのみ(内部詳細をクライアントに出さない)
          console.warn("registry user mode failed:", err);
          return manualOnly({ mode: "user", stale: true });
        }
      }
    }

    // ---- 2. 手動のみ(Google 未連携) ----
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
