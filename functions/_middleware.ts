/**
 * 認証ゲート (Cloudflare Pages middleware) — Clerk 版。
 *
 * functions/_middleware.ts はプロジェクトへの **全リクエスト**(静的アセットの
 * 画面ファイルを含む)に割り込む。ここで Clerk のセッションを検証し、サインイン済みの
 * 人だけを通す。認証は Clerk に一本化しており(Google OAuth / Cloudflare Access の
 * 使い分けは廃止)、本番のカスタムドメインでもプレビューの pages.dev でも **同一のコード
 * 経路**でゲートする(環境差はデプロイに渡す Clerk キーだけ)。
 *
 * **誰がサインインできるか(許可制御)は Clerk 側で管理する**(Restrictions の Allowlist、
 * または Invitations)。したがってサインインを通過した時点で許可済みとみなし、アプリ側に
 * 許可リスト(env/KV)は持たない。オフボーディングは Clerk でユーザーを削除/BAN する。
 *
 * 判定:
 *   - Clerk 未設定(キー欠落)          → 503 (fail-closed。設定漏れで全公開を防ぐ)
 *   - 公開パス(/api/health)           → next()
 *   - handshake(Cookie 確定が必要)    → Clerk の Set-Cookie + Location をそのまま返す
 *   - サインイン済み                    → next()(Clerk が付ける Cookie 更新は伝播)
 *   - 未サインインの画面遷移(GET html)  → Clerk サインイン画面へ 302
 *   - 未サインインの API                → 401(JSON)
 */
import type { Env } from "../src/server/app";
import { authenticate } from "../src/server/auth/clerk";

const PUBLIC_PATHS = new Set(["/api/health"]);

type MiddlewareContext = {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
};

/** Clerk が付けたセッション Cookie 更新(あれば)を下流レスポンスに伝播する。 */
function withClerkCookies(res: Response, headers: Headers): Response {
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) return res;
  const merged = new Headers(res.headers);
  for (const c of cookies) merged.append("set-cookie", c);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: merged,
  });
}

export async function onRequest(
  context: MiddlewareContext,
): Promise<Response> {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (PUBLIC_PATHS.has(url.pathname)) return next();

  const auth = await authenticate(env, request);

  if (!auth.configured) {
    // Clerk 未設定で素通しすると全公開になるため fail-closed。
    return new Response(
      "認証が未設定です。CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY を設定してください。",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // Clerk 側にセッションがあるが本ドメインの Cookie 未確定。Clerk の指示どおり
  // Set-Cookie + Location を返して Cookie を確定させる(ClerkJS 無しでも成立する)。
  if (auth.status === "handshake") {
    return new Response(null, { status: 307, headers: auth.headers });
  }

  if (auth.status === "signed-in") {
    // 許可制御は Clerk が担う(サインインできた=許可済み)。
    return withClerkCookies(await next(), auth.headers);
  }

  // signed-out
  const wantsHtml =
    request.method === "GET" &&
    (request.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml && auth.signInUrl) {
    const signIn = new URL(auth.signInUrl);
    signIn.searchParams.set("redirect_url", url.toString());
    return Response.redirect(signIn.toString(), 302);
  }
  return new Response(
    JSON.stringify({ error: "認証が必要です" }),
    {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
