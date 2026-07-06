import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type Env } from "../src/server/app";
import { loadRegistry } from "../src/server/registry";
import {
  isAllowed,
  loadAllowlistFromKV,
  matchesPattern,
  parseAllowlistEnv,
  resolveAllowlist,
  type KVNamespace,
} from "../src/server/auth/allowlist";
import {
  buildAuthUrl,
  parseIdToken,
  pkceChallenge,
  randomString,
} from "../src/server/auth/google";
import {
  createSessionToken,
  getSessionFromRequest,
  SESSION_COOKIE,
  verifySessionToken,
} from "../src/server/auth/session";

const SECRET = "test-secret-value-do-not-use-in-prod";

const registry = loadRegistry({
  apps: [
    {
      id: "tool-a",
      name: "ツールA",
      description: "テスト",
      category: "設計",
      tags: [],
      url: "https://example.com/a",
    },
  ],
});

const app = createApp(registry);

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_SECRET: SECRET,
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    ALLOWED_EMAIL_DOMAINS: "*@example.co.jp",
    ...overrides,
  };
}

/** UTF-8 安全な base64url */
function b64url(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeIdToken(payload: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256" })}.${b64url(payload)}.sig`;
}

function readSetCookie(res: Response, name: string): string | undefined {
  const raw = res.headers.get("set-cookie");
  if (!raw) return undefined;
  const m = raw.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return m?.[1];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("matchesPattern", () => {
  it("ワイルドカードでドメイン全体に一致する", () => {
    expect(matchesPattern("taro@example.co.jp", "*@example.co.jp")).toBe(true);
    expect(matchesPattern("taro@evil.com", "*@example.co.jp")).toBe(false);
  });

  it("大文字小文字を無視する", () => {
    expect(matchesPattern("Taro@Example.CO.JP", "*@example.co.jp")).toBe(true);
  });

  it("ワイルドカード無しは完全一致", () => {
    expect(matchesPattern("foo@partner.com", "foo@partner.com")).toBe(true);
    expect(matchesPattern("foobar@partner.com", "foo@partner.com")).toBe(false);
  });

  it("サブドメインにもワイルドカードを使える", () => {
    expect(matchesPattern("a@team.example.co.jp", "*@*.example.co.jp")).toBe(
      true,
    );
    expect(matchesPattern("a@example.co.jp", "*@*.example.co.jp")).toBe(false);
  });

  it("空パターンには一致しない", () => {
    expect(matchesPattern("a@b.com", "")).toBe(false);
  });
});

describe("parseAllowlistEnv / isAllowed", () => {
  it("カンマ・空白区切りを正規化する", () => {
    expect(
      parseAllowlistEnv("*@example.co.jp, foo@partner.com", " bar@x.com"),
    ).toEqual(["*@example.co.jp", "foo@partner.com", "bar@x.com"]);
  });

  it("いずれかに一致すれば許可", () => {
    const list = ["*@example.co.jp", "foo@partner.com"];
    expect(isAllowed("anyone@example.co.jp", list)).toBe(true);
    expect(isAllowed("foo@partner.com", list)).toBe(true);
    expect(isAllowed("stranger@nope.com", list)).toBe(false);
  });
});

describe("loadAllowlistFromKV / resolveAllowlist", () => {
  function fakeKV(value: string | null): KVNamespace {
    return {
      get: async () => value,
      put: async () => {},
      delete: async () => {},
    };
  }

  it("JSON配列を読む", async () => {
    expect(
      await loadAllowlistFromKV(fakeKV('["*@example.co.jp","x@y.com"]')),
    ).toEqual(["*@example.co.jp", "x@y.com"]);
  });

  it("{patterns:[...]} 形式も読む", async () => {
    expect(
      await loadAllowlistFromKV(fakeKV('{"patterns":["a@b.com"]}')),
    ).toEqual(["a@b.com"]);
  });

  it("未設定・不正JSONは空配列", async () => {
    expect(await loadAllowlistFromKV(fakeKV(null))).toEqual([]);
    expect(await loadAllowlistFromKV(fakeKV("{not json"))).toEqual([]);
    expect(await loadAllowlistFromKV(undefined)).toEqual([]);
  });

  it("env と KV を統合(重複除去)する", async () => {
    const list = await resolveAllowlist({
      ALLOWED_EMAILS: "foo@partner.com",
      ALLOWED_EMAIL_DOMAINS: "*@example.co.jp",
      AUTH_KV: fakeKV('["bar@partner.com","*@example.co.jp"]'),
    });
    expect(list.sort()).toEqual(
      ["*@example.co.jp", "bar@partner.com", "foo@partner.com"].sort(),
    );
  });
});

describe("session token", () => {
  it("発行→検証のラウンドトリップ", async () => {
    const token = await createSessionToken(
      { email: "taro@example.co.jp", name: "太郎" },
      SECRET,
      24,
    );
    expect(await verifySessionToken(token, SECRET)).toEqual({
      email: "taro@example.co.jp",
      name: "太郎",
    });
  });

  it("改ざん・別シークレットは null", async () => {
    const token = await createSessionToken(
      { email: "taro@example.co.jp" },
      SECRET,
      24,
    );
    expect(await verifySessionToken(token + "x", SECRET)).toBeNull();
    expect(await verifySessionToken(token, "other-secret")).toBeNull();
  });

  it("期限切れは null", async () => {
    const token = await createSessionToken(
      { email: "taro@example.co.jp" },
      SECRET,
      -1,
    );
    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it("Cookie ヘッダから読み取れる", async () => {
    const token = await createSessionToken(
      { email: "taro@example.co.jp" },
      SECRET,
      24,
    );
    const req = new Request("https://portal.example.com/", {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=${token}` },
    });
    expect(await getSessionFromRequest(req, SECRET)).toEqual({
      email: "taro@example.co.jp",
    });
  });
});

describe("google helpers", () => {
  it("認可URLに必要なパラメータを含む", () => {
    const url = new URL(
      buildAuthUrl(
        {
          clientId: "cid",
          clientSecret: "sec",
          redirectUri: "https://portal.example.com/api/auth/callback",
        },
        { state: "st", codeChallenge: "ch", hostedDomain: "example.co.jp" },
      ),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://portal.example.com/api/auth/callback",
    );
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("hd")).toBe("example.co.jp");
  });

  it("PKCE challenge は base64url で決定的", async () => {
    const a = await pkceChallenge("verifier-123");
    const b = await pkceChallenge("verifier-123");
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("randomString は都度変わる", () => {
    expect(randomString()).not.toBe(randomString());
  });

  it("parseIdToken は正しいクレームを取り出す", () => {
    const idToken = fakeIdToken({
      iss: "https://accounts.google.com",
      aud: "cid",
      email: "taro@example.co.jp",
      email_verified: true,
      name: "太郎",
      hd: "example.co.jp",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    expect(parseIdToken(idToken, "cid")).toEqual({
      email: "taro@example.co.jp",
      emailVerified: true,
      name: "太郎",
      hd: "example.co.jp",
    });
  });

  it("aud 不一致・iss 不正・期限切れを弾く", () => {
    const base = {
      iss: "https://accounts.google.com",
      aud: "cid",
      email: "a@b.com",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    expect(() => parseIdToken(fakeIdToken(base), "other")).toThrow();
    expect(() =>
      parseIdToken(fakeIdToken({ ...base, iss: "https://evil.com" }), "cid"),
    ).toThrow();
    expect(() =>
      parseIdToken(
        fakeIdToken({ ...base, exp: Math.floor(Date.now() / 1000) - 10 }),
        "cid",
      ),
    ).toThrow();
  });
});

describe("GET /api/me", () => {
  it("未認証は401", async () => {
    const res = await app.request("/api/me", {}, baseEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("有効なセッションCookieなら200でメールを返す", async () => {
    const token = await createSessionToken(
      { email: "taro@example.co.jp", name: "太郎" },
      SECRET,
      24,
    );
    const res = await app.request(
      "/api/me",
      { headers: { cookie: `${SESSION_COOKIE}=${token}` } },
      baseEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authenticated: true,
      email: "taro@example.co.jp",
      name: "太郎",
    });
  });

  it("AUTH_SECRET 未設定は503", async () => {
    const res = await app.request("/api/me", {}, baseEnv({ AUTH_SECRET: undefined }));
    expect(res.status).toBe(503);
  });
});

describe("GET /api/auth/login", () => {
  it("Googleへ302し、stateCookieとPKCEを設定する", async () => {
    const res = await app.request("/api/auth/login", {}, baseEnv());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(readSetCookie(res, "portal_oauth")).toBeTruthy();
  });

  it("Google未設定は503", async () => {
    const res = await app.request(
      "/api/auth/login",
      {},
      baseEnv({ GOOGLE_CLIENT_ID: undefined }),
    );
    expect(res.status).toBe(503);
  });
});

describe("GET /api/auth/callback", () => {
  /** login を実行して state と oauth Cookie を取り出す */
  async function startLogin(env: Env) {
    const res = await app.request("/api/auth/login", {}, env);
    const location = new URL(res.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    const oauthCookie = readSetCookie(res, "portal_oauth")!;
    return { state, oauthCookie };
  }

  function stubTokenEndpoint(payload: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id_token: fakeIdToken(payload) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  it("許可されたユーザーはセッションCookieを得て / へ302", async () => {
    const env = baseEnv();
    const { state, oauthCookie } = await startLogin(env);
    stubTokenEndpoint({
      iss: "https://accounts.google.com",
      aud: env.GOOGLE_CLIENT_ID,
      email: "taro@example.co.jp",
      email_verified: true,
      name: "太郎",
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    const res = await app.request(
      `/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `portal_oauth=${oauthCookie}` } },
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const session = readSetCookie(res, SESSION_COOKIE);
    expect(session).toBeTruthy();
    expect(await verifySessionToken(session!, SECRET)).toEqual({
      email: "taro@example.co.jp",
      name: "太郎",
    });
  });

  it("許可リスト外のユーザーは403(セッション無し)", async () => {
    const env = baseEnv();
    const { state, oauthCookie } = await startLogin(env);
    stubTokenEndpoint({
      iss: "https://accounts.google.com",
      aud: env.GOOGLE_CLIENT_ID,
      email: "stranger@nope.com",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    const res = await app.request(
      `/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `portal_oauth=${oauthCookie}` } },
      env,
    );

    expect(res.status).toBe(403);
    expect(readSetCookie(res, SESSION_COOKIE)).toBeUndefined();
  });

  it("state不一致は400(トークン交換しない)", async () => {
    const env = baseEnv();
    const { oauthCookie } = await startLogin(env);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request(
      `/api/auth/callback?code=abc&state=WRONG`,
      { headers: { cookie: `portal_oauth=${oauthCookie}` } },
      env,
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("email未確認は403", async () => {
    const env = baseEnv();
    const { state, oauthCookie } = await startLogin(env);
    stubTokenEndpoint({
      iss: "https://accounts.google.com",
      aud: env.GOOGLE_CLIENT_ID,
      email: "taro@example.co.jp",
      email_verified: false,
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    const res = await app.request(
      `/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `portal_oauth=${oauthCookie}` } },
      env,
    );
    expect(res.status).toBe(403);
  });
});
