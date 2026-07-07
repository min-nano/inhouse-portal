/**
 * 認証ゲート (Cloudflare Pages middleware)。
 *
 * functions/_middleware.ts はプロジェクトへの **全リクエスト**(静的アセットの
 * 画面ファイルを含む)に割り込むため、ここで自前セッションを検証する。
 * これにより Cloudflare Access を使わずに、外部DNSのカスタムドメイン上でも
 * ポータル全体をアクセス制限できる。
 *
 * - 認証済み → next() で通常配信(静的アセット or /api/*)
 * - 未認証の画面遷移(GET + Accept: text/html) → /api/auth/login へ 302
 * - 未認証のAPI → 401(JSON)
 * - /api/auth/* と /api/health は認証不要(ログイン導線・死活監視)
 *
 * プレビュー(PR)デプロイは Cloudflare Access で保護できる(pages.dev は
 * Cloudflare 所有ゾーンなので Access が無料で効く)。本番/プレビューの判定は
 * **追加の環境変数なし**で行う。Pages の CF_PAGES_* はビルド時変数でランタイムには
 * 無いため、ランタイムで使える2つの手掛かりを組み合わせる:
 *   - ホスト名: プレビューは `*.pages.dev`、本番はカスタムドメイン
 *   - Cloudflare Access が前段にいると全リクエストに付く `Cf-Access-Jwt-Assertion`
 * `*.pages.dev` かつ Access アサーションがあれば「Access 保護済み」として Function
 * 認証をスルーする。カスタムドメインでは(ヘッダ偽装があっても)常に OAuth を要求し、
 * Access 無しの pages.dev はヘッダが無いので OAuth にフォールバックする(fail-closed)。
 */
import type { Env } from "../src/server/app";
import { getSessionFromRequest } from "../src/server/auth/session";

const PUBLIC_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/callback",
  "/api/auth/logout",
  "/api/health",
]);

type MiddlewareContext = {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
};

export async function onRequest(
  context: MiddlewareContext,
): Promise<Response> {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 追加変数なしの環境判定: pages.dev 上で Cloudflare Access のアサーションが
  // 付いていれば、Access が edge で保護済みなので Function 認証はスルーする。
  // バイパスは pages.dev ホスト限定なので、本番カスタムドメインは(ヘッダ偽装が
  // あっても)常に OAuth を要求する。
  const behindAccess =
    url.hostname.endsWith(".pages.dev") &&
    request.headers.has("Cf-Access-Jwt-Assertion");
  if (behindAccess) return next();

  if (PUBLIC_PATHS.has(url.pathname)) return next();

  const secret = env.AUTH_SECRET;
  if (!secret) {
    // secret 未設定で素通しすると全公開になってしまうため、fail-closed。
    return new Response(
      "認証が未設定です。AUTH_SECRET / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を設定してください。",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const user = await getSessionFromRequest(request, secret);
  if (user) return next();

  // 未認証
  const accept = request.headers.get("accept") ?? "";
  if (request.method === "GET" && accept.includes("text/html")) {
    const loginUrl = new URL("/api/auth/login", url);
    loginUrl.searchParams.set("redirect", url.pathname + url.search);
    return Response.redirect(loginUrl.toString(), 302);
  }
  return new Response(
    JSON.stringify({ error: "認証が必要です", login: "/api/auth/login" }),
    {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
