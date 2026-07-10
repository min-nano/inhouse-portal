import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Env } from "../src/server/app";
import { loadRegistry } from "../src/server/registry";
import type { KVNamespace } from "../src/server/auth/allowlist";
import { createSessionToken, SESSION_COOKIE } from "../src/server/auth/session";
import {
  isConnected,
  loadStoredToken,
  saveRefreshToken,
} from "../src/server/auth/token-store";

const SECRET = "test-secret-please-change-0123456789";

const registry = loadRegistry({
  apps: [
    {
      id: "tool-a",
      name: "手動ツール",
      description: "",
      category: "設計",
      tags: ["gas"],
      url: "https://script.google.com/macros/s/AAA/exec",
    },
  ],
});
const app = createApp(registry);

function memoryKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
  };
}

function baseEnv(kv: KVNamespace, overrides: Partial<Env> = {}): Env {
  return {
    AUTH_SECRET: SECRET,
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    ALLOWED_EMAIL_DOMAINS: "*@example.co.jp",
    AUTH_KV: kv,
    ...overrides,
  };
}

async function sessionCookie(email: string): Promise<string> {
  const token = await createSessionToken({ email }, SECRET, 24);
  return `${SESSION_COOKIE}=${token}`;
}

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
  const m = new RegExp(`${name}=([^;]+)`).exec(raw);
  return m?.[1];
}

/** URLで分岐する fetch モック */
function routeFetch(
  handlers: (url: string) => { status?: number; body: unknown } | undefined,
) {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handlers(url);
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ログイン時スコープ要求 (方式B)", () => {
  it("REGISTRY_LOGIN_SCOPES 有効時、login は offline + Driveスコープを要求する", async () => {
    const res = await app.request(
      "/api/auth/login",
      {},
      baseEnv(memoryKV(), { REGISTRY_LOGIN_SCOPES: "1" }),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("scope")).toContain("drive.metadata.readonly");
    expect(loc.searchParams.get("scope")).toContain(
      "script.deployments.readonly",
    );
  });

  it("フラグ無効時は従来どおり identity スコープのみ", async () => {
    const res = await app.request(
      "/api/auth/login",
      {},
      baseEnv(memoryKV()),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("access_type")).toBeNull();
    expect(loc.searchParams.get("scope")).not.toContain("drive");
  });

  it("コールバックでリフレッシュトークンを暗号化保管する", async () => {
    const kv = memoryKV();
    const env = baseEnv(kv, { REGISTRY_LOGIN_SCOPES: "1" });

    // login で state と oauth cookie を得る
    const login = await app.request("/api/auth/login", {}, env);
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const oauthCookie = readSetCookie(login, "portal_oauth")!;

    // token エンドポイントが refresh_token を返す
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id_token: fakeIdToken({
                iss: "https://accounts.google.com",
                aud: "client-id",
                email: "taro@example.co.jp",
                email_verified: true,
                exp: Math.floor(Date.now() / 1000) + 600,
              }),
              access_token: "ya29.at",
              refresh_token: "1//rt-value",
              expires_in: 3600,
              scope:
                "openid email https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/script.deployments.readonly",
            }),
            { status: 200 },
          ),
      ),
    );

    const res = await app.request(
      `/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `portal_oauth=${oauthCookie}` } },
      env,
    );
    expect(res.status).toBe(302);
    expect(readSetCookie(res, SESSION_COOKIE)).toBeTruthy();
    const stored = await loadStoredToken(kv, SECRET, "taro@example.co.jp");
    expect(stored?.refreshToken).toBe("1//rt-value");
  });

  it("granular consent でDriveスコープを外された場合はトークンを保管しない", async () => {
    const kv = memoryKV();
    const env = baseEnv(kv, { REGISTRY_LOGIN_SCOPES: "1" });
    const login = await app.request("/api/auth/login", {}, env);
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const oauthCookie = readSetCookie(login, "portal_oauth")!;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id_token: fakeIdToken({
                iss: "https://accounts.google.com",
                aud: "client-id",
                email: "taro@example.co.jp",
                email_verified: true,
                exp: Math.floor(Date.now() / 1000) + 600,
              }),
              access_token: "ya29.at",
              refresh_token: "1//rt-value",
              expires_in: 3600,
              scope: "openid email", // Driveスコープを外された
            }),
            { status: 200 },
          ),
      ),
    );
    const res = await app.request(
      `/api/auth/callback?code=abc&state=${state}`,
      { headers: { cookie: `portal_oauth=${oauthCookie}` } },
      env,
    );
    expect(res.status).toBe(302); // ログイン自体は成功
    expect(await isConnected(kv, "taro@example.co.jp")).toBe(false); // 保管はしない
  });

  it("?reconnect=1 のログインは prompt=consent を付ける", async () => {
    const res = await app.request(
      "/api/auth/login?reconnect=1",
      {},
      baseEnv(memoryKV(), { REGISTRY_LOGIN_SCOPES: "1" }),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("prompt")).toBe("consent");
  });
});

describe("GET /api/registry (ユーザーモード)", () => {
  let kv: KVNamespace;
  beforeEach(async () => {
    kv = memoryKV();
    await saveRefreshToken(kv, SECRET, "u@example.co.jp", {
      refreshToken: "1//rt",
      connectedAt: 1,
    });
  });

  it("連携済みなら本人権限のGASをマージして返す", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((u) => {
        if (u.includes("oauth2.googleapis.com/token"))
          return { body: { access_token: "ya29.at", expires_in: 3600 } };
        if (u.includes("/drive/"))
          return {
            body: {
              files: [
                { id: "SID9", name: "自分の日報", modifiedTime: "2026-07-01T00:00:00Z" },
              ],
            },
          };
        if (u.includes("/SID9/deployments"))
          return {
            body: {
              deployments: [
                {
                  updateTime: "2026-07-02T00:00:00Z",
                  entryPoints: [
                    {
                      entryPointType: "WEB_APP",
                      webApp: { url: "https://script.google.com/macros/s/SID9/exec" },
                    },
                  ],
                },
              ],
            },
          };
        return undefined;
      }),
    );
    const res = await app.request(
      "/api/registry",
      { headers: { cookie: await sessionCookie("u@example.co.jp") } },
      baseEnv(kv),
    );
    const body = (await res.json()) as {
      apps: { name: string; auto: boolean }[];
      source: { mode: string; auto: number };
    };
    expect(body.source).toMatchObject({ mode: "user", auto: 1 });
    expect(body.apps.map((a) => a.name)).toContain("自分の日報");
  });

  it("リフレッシュ失効(400)なら自動でトークン削除し手動分を返す", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((u) =>
        u.includes("oauth2.googleapis.com/token")
          ? { status: 400, body: { error: "invalid_grant" } }
          : undefined,
      ),
    );
    const res = await app.request(
      "/api/registry",
      { headers: { cookie: await sessionCookie("u@example.co.jp") } },
      baseEnv(kv),
    );
    const body = (await res.json()) as {
      apps: unknown[];
      source: { userAuthExpired?: boolean };
    };
    expect(body.source.userAuthExpired).toBe(true);
    expect(body.apps).toHaveLength(1); // 手動分のみ
    expect(await isConnected(kv, "u@example.co.jp")).toBe(false);
  });

  it("一時的なリフレッシュ失敗(invalid_client/401)ではトークンを削除しない", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((u) =>
        u.includes("oauth2.googleapis.com/token")
          ? { status: 401, body: { error: "invalid_client" } }
          : undefined,
      ),
    );
    const res = await app.request(
      "/api/registry",
      { headers: { cookie: await sessionCookie("u@example.co.jp") } },
      baseEnv(kv),
    );
    const body = (await res.json()) as {
      source: { stale?: boolean; userAuthExpired?: boolean };
    };
    expect(body.source.stale).toBe(true);
    expect(body.source.userAuthExpired).toBeUndefined();
    // 設定ミス由来なので保管トークンは残す(復旧可能にする)
    expect(await isConnected(kv, "u@example.co.jp")).toBe(true);
  });

  it("Apps Script API 未有効(全403)なら手動分+ヒントを返す", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((u) => {
        if (u.includes("oauth2.googleapis.com/token"))
          return { body: { access_token: "ya29.at", expires_in: 3600 } };
        if (u.includes("/drive/"))
          return { body: { files: [{ id: "SID9", name: "x" }] } };
        return { status: 403, body: {} };
      }),
    );
    const res = await app.request(
      "/api/registry",
      { headers: { cookie: await sessionCookie("u@example.co.jp") } },
      baseEnv(kv),
    );
    const body = (await res.json()) as {
      source: { appsScriptApiDisabled?: boolean };
    };
    expect(body.source.appsScriptApiDisabled).toBe(true);
  });

  it("未ログインは手動/共有へフォールバック(ユーザーモードに入らない)", async () => {
    const res = await app.request("/api/registry", {}, baseEnv(kv));
    const body = (await res.json()) as { source: { mode: string } };
    expect(body.source.mode).not.toBe("user");
  });
});
