/**
 * 認証ゲート (Cloudflare Pages middleware) — Clerk 版。
 *
 * ゲートの境界は /api/*(データ・操作)に置く。画面(静的 HTML/JS/CSS)は
 * 公開し、クライアントの ClerkJS が UI をゲートする(未サインインなら Clerk の
 * サインイン画面へリダイレクト)。静的シェルには機密が無く、実データ・操作はすべて
 * /api/* の内側にあるため、この境界で保護は成立する。
 *
 * こうすることで未サインインでもシェル + ClerkJS が読み込まれ、ClerkJS が dev ブラウザ
 * 機構を含む Clerk のフローを正しく処理できる(production の同一レジスタブルドメインでも、
 * preview の `*.pages.dev`(development インスタンス)でも、サインイン後の戻りが成立する)。
 *
 * 判定(/api/* のみ):
 *   - Clerk 未設定(キー欠落)           → 503(fail-closed。設定漏れで API 全公開を防ぐ)
 *   - 公開 API(/api/health)            → next()
 *   - サインイン済み                     → next()(Clerk が付ける Cookie 更新は伝播)
 *   - 未サインイン / handshake           → 401(JSON)。
 *       ※ API に 3xx を返すと fetch が壊れるためリダイレクトはしない。サインイン誘導と
 *          セッション確立はクライアントの ClerkJS が担う。
 */
import type { Env } from "../src/server/app";
import { authenticate } from "../src/server/auth/clerk";

/** 認証不要の API パス。 */
const PUBLIC_API_PATHS = new Set(["/api/health"]);

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

  // 画面などの静的アセットは公開(ClerkJS がクライアントでゲートする)。保護対象は
  // データ/操作を扱う /api/* のみ。/api/health は生存確認用の公開パス。
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  if (!isApi || PUBLIC_API_PATHS.has(url.pathname)) {
    return next();
  }

  const auth = await authenticate(env, request);

  if (!auth.configured) {
    // Clerk 未設定で素通しすると API が全公開になるため fail-closed。
    return new Response(
      "認証が未設定です。CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY を設定してください。",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  if (auth.status === "signed-in") {
    // 許可制御は Clerk が担う(サインインできた=許可済み)。
    return withClerkCookies(await next(), auth.headers);
  }

  // 未サインイン / handshake(本ドメインの Cookie 未確定)。API には JSON 401 を返す。
  // リダイレクト(302/307)は fetch を壊すため使わない。サインイン誘導と Cookie 確定は
  // クライアントの ClerkJS が担い、確立後に API を再試行する。
  return new Response(
    JSON.stringify({ error: "認証が必要です" }),
    {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}
