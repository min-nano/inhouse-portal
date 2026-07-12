/**
 * 認証ゲート (Cloudflare Pages middleware) — Clerk 版。
 *
 * functions/_middleware.ts はプロジェクトへの **全リクエスト**(静的アセットの
 * 画面ファイルを含む)に割り込む。ここで Clerk のセッションを検証し、許可リストに
 * 載っている人だけを通す。認証は Clerk に一本化しており(Google OAuth / Cloudflare
 * Access の使い分けは廃止)、本番のカスタムドメインでもプレビューの pages.dev でも
 * **同一のコード経路**でゲートする(環境差はデプロイに渡す Clerk キーだけ)。
 *
 * 判定:
 *   - Clerk 未設定(キー欠落)          → 503 (fail-closed。設定漏れで全公開を防ぐ)
 *   - 公開パス(/api/health)           → next()
 *   - handshake(Cookie 確定が必要)    → Clerk の Set-Cookie + Location をそのまま返す
 *   - サインイン済み + 許可リスト合致    → next()(Clerk が付ける Cookie 更新は伝播)
 *   - サインイン済みだが許可リスト外      → 403(画面は説明HTML / API は JSON)
 *   - 未サインインの画面遷移(GET html)  → Clerk サインイン画面へ 302
 *   - 未サインインの API                → 401(JSON)
 */
import type { Env } from "../src/server/app";
import { authenticate } from "../src/server/auth/clerk";
import {
  isAllowed,
  resolveAllowlist,
  type Allowlist,
} from "../src/server/auth/allowlist";

const PUBLIC_PATHS = new Set(["/api/health"]);

type MiddlewareContext = {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
};

// 許可リストは全リクエストで参照するため、isolate 内で短時間キャッシュして
// KV 読み取り(env + KV の和集合を解決)を毎回走らせない。env は不変・KV は低頻度更新。
let allowlistCache: { at: number; value: Allowlist } | null = null;
const ALLOWLIST_TTL_MS = 60_000;

async function getAllowlist(env: Env, secret: string): Promise<Allowlist> {
  const now = Date.now();
  if (allowlistCache && now - allowlistCache.at < ALLOWLIST_TTL_MS) {
    return allowlistCache.value;
  }
  const value = await resolveAllowlist(env, secret);
  allowlistCache = { at: now, value };
  return value;
}

/** テスト用: 許可リストキャッシュを消す。 */
export function resetAllowlistCache(): void {
  allowlistCache = null;
}

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

function forbiddenPage(email: string | undefined): string {
  const safe = (email ?? "").replace(/[<>&]/g, "");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>アクセス権がありません</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7}</style>
</head><body>
<h1>アクセス権がありません</h1>
<p>${safe ? `<strong>${safe}</strong> は` : ""}このポータルの許可リストに登録されていません。</p>
<p>心当たりがない場合は管理者にご連絡ください。別のアカウントで試すには
<a href="/api/auth/logout">こちらからログアウト</a>してください。</p>
</body></html>`;
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

  const wantsHtml =
    request.method === "GET" &&
    (request.headers.get("accept") ?? "").includes("text/html");

  if (auth.status === "signed-out") {
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

  // signed-in: 許可リスト照合(社内ドメイン + 指名した協力者のみ通す)
  const secret = env.AUTH_SECRET ?? "";
  const allowlist = await getAllowlist(env, secret);
  if (auth.email && (await isAllowed(auth.email, allowlist, secret))) {
    return withClerkCookies(await next(), auth.headers);
  }

  // 認証は済んでいるが許可リスト外(または email 未解決)
  if (wantsHtml) {
    return new Response(forbiddenPage(auth.email), {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(
    JSON.stringify({ error: "アクセス権がありません" }),
    {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
