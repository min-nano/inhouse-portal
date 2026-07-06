/**
 * GASエンドポイントへの中継プロキシ。
 *
 * - GASの生URL (/exec) はブラウザに出さず、Pagesの環境変数 (PROXY_TARGETS) にのみ保持する
 * - サーバー間通信になるため CORS の制約を受けない
 * - GAS はレスポンス時に script.googleusercontent.com へ302リダイレクトするため
 *   redirect: "follow" で追従する
 */

const ALLOWED_METHODS = new Set(["GET", "POST"]);

export type ProxyTargets = Record<string, string>;

/** PROXY_TARGETS secret (JSON文字列) をパースする。未設定は空マップ扱い。 */
export function parseProxyTargets(raw: string | undefined): ProxyTargets {
  if (!raw || raw.trim() === "") {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PROXY_TARGETS はオブジェクト形式のJSONで指定してください");
  }
  const targets: ProxyTargets = {};
  for (const [id, url] of Object.entries(parsed)) {
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error(`PROXY_TARGETS[${id}] はhttpsのURL文字列で指定してください`);
    }
    targets[id] = url;
  }
  return targets;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 受信リクエストを targets[id] へ転送する。
 * クエリ文字列は透過し、POSTはボディとContent-Typeを引き継ぐ。
 */
export async function proxyRequest(
  targets: ProxyTargets,
  id: string,
  request: Request,
): Promise<Response> {
  const base = targets[id];
  if (!base) {
    return jsonError(404, `プロキシ先が未登録です: ${id}`);
  }
  if (!ALLOWED_METHODS.has(request.method)) {
    return jsonError(405, `許可されていないメソッドです: ${request.method}`);
  }

  const incoming = new URL(request.url);
  const target = new URL(base);
  incoming.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value);
  });

  const init: RequestInit = {
    method: request.method,
    redirect: "follow",
  };
  if (request.method === "POST") {
    init.body = await request.arrayBuffer();
    const contentType = request.headers.get("content-type");
    if (contentType) {
      init.headers = { "content-type": contentType };
    }
  }

  const upstream = await fetch(target.toString(), init);

  // Set-Cookie等の不要ヘッダは伝播させず、必要最小限のみ返す
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }
  headers.set("cache-control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
