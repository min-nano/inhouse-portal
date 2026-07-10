import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type Env } from "../src/server/app";
import { loadRegistry } from "../src/server/registry";
import type { KVNamespace } from "../src/server/auth/allowlist";
import { createSessionToken } from "../src/server/auth/session";
import {
  isConnected,
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
    AUTH_KV: kv,
    ...overrides,
  };
}

async function sessionCookie(email: string): Promise<string> {
  const token = await createSessionToken({ email }, SECRET, 24);
  return `portal_session=${token}`;
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

describe("GET /api/registry/status", () => {
  it("未ログインは connected/authenticated=false", async () => {
    const res = await app.request(
      "/api/registry/status",
      {},
      baseEnv(memoryKV()),
    );
    const body = await res.json();
    expect(body).toMatchObject({ authenticated: false, available: true });
  });

  it("連携済みユーザーは connected=true", async () => {
    const kv = memoryKV();
    await saveRefreshToken(kv, SECRET, "u@example.co.jp", {
      refreshToken: "1//rt",
      connectedAt: 1,
    });
    const res = await app.request(
      "/api/registry/status",
      { headers: { cookie: await sessionCookie("u@example.co.jp") } },
      baseEnv(kv),
    );
    expect(await res.json()).toMatchObject({
      authenticated: true,
      connected: true,
    });
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
              files: [{ id: "SID9", name: "自分の日報", modifiedTime: "2026-07-01T00:00:00Z" }],
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
    expect(body.apps.find((a) => a.auto)?.auto).toBe(true);
  });

  it("リフレッシュ失効(400)なら自動で連携解除し手動分を返す", async () => {
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
    // 失効トークンは削除されている
    expect(await isConnected(kv, "u@example.co.jp")).toBe(false);
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
});

describe("POST /api/registry/disconnect", () => {
  it("連携解除でトークンを削除しGoogleへrevokeする", async () => {
    const kv = memoryKV();
    await saveRefreshToken(kv, SECRET, "u@example.co.jp", {
      refreshToken: "1//rt",
      connectedAt: 1,
    });
    const revoke = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", revoke);

    const res = await app.request(
      "/api/registry/disconnect",
      { method: "POST", headers: { cookie: await sessionCookie("u@example.co.jp") } },
      baseEnv(kv),
    );
    expect(res.status).toBe(200);
    expect(await isConnected(kv, "u@example.co.jp")).toBe(false);
    expect(revoke).toHaveBeenCalled();
  });

  it("未ログインは401", async () => {
    const res = await app.request(
      "/api/registry/disconnect",
      { method: "POST" },
      baseEnv(memoryKV()),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/registry/connect", () => {
  it("ログイン中ユーザーをGoogle同意画面へリダイレクトする", async () => {
    const res = await app.request(
      "/api/registry/connect?redirect=/",
      { headers: { cookie: await sessionCookie("u@example.co.jp") } },
      baseEnv(memoryKV()),
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("accounts.google.com");
    expect(loc).toContain("access_type=offline");
    expect(loc).toContain("prompt=consent");
    expect(decodeURIComponent(loc)).toContain(
      "drive.metadata.readonly",
    );
  });

  it("未ログインは401", async () => {
    const res = await app.request(
      "/api/registry/connect",
      {},
      baseEnv(memoryKV()),
    );
    expect(res.status).toBe(401);
  });
});
