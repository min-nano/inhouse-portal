import { afterEach, describe, expect, it, vi } from "vitest";

// Clerk ラッパーはモックする。/api/registry のユーザーモード(本人権限での GAS 列挙)は、
// Clerk から得た Google アクセストークンで Drive / Apps Script API を叩く経路をテストする。
vi.mock("../src/server/auth/clerk", () => ({
  authenticate: vi.fn(),
  getGoogleAccessToken: vi.fn(),
  getClerkClient: vi.fn(() => null),
  authorizedParties: vi.fn(() => undefined),
}));

import { createApp, type Env } from "../src/server/app";
import { loadRegistry } from "../src/server/registry";
import {
  authenticate,
  getGoogleAccessToken,
  type ClerkAuth,
} from "../src/server/auth/clerk";

const authMock = authenticate as unknown as ReturnType<typeof vi.fn>;
const tokenMock = getGoogleAccessToken as unknown as ReturnType<typeof vi.fn>;

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

const baseEnv: Env = {
  CLERK_PUBLISHABLE_KEY: "pk_test_x",
  CLERK_SECRET_KEY: "sk_test_x",
  ALLOWED_EMAIL_DOMAINS: "*@example.co.jp",
};

function signedIn(email = "u@example.co.jp"): ClerkAuth {
  return {
    configured: true,
    status: "signed-in",
    client: {} as never,
    userId: "user_1",
    email,
    headers: new Headers(),
  };
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
  authMock.mockReset();
  tokenMock.mockReset();
});

describe("GET /api/registry (ユーザーモード / Clerk 経由の Google トークン)", () => {
  it("Google 連携済みなら本人権限のGASをマージして返す", async () => {
    authMock.mockResolvedValue(signedIn());
    tokenMock.mockResolvedValue("ya29.at");
    vi.stubGlobal(
      "fetch",
      routeFetch((u) => {
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
    const res = await app.request("/api/registry", {}, baseEnv);
    const body = (await res.json()) as {
      apps: { name: string; auto: boolean }[];
      source: { mode: string; auto: number };
    };
    expect(body.source).toMatchObject({ mode: "user", auto: 1 });
    expect(body.apps.map((a) => a.name)).toContain("自分の日報");
  });

  it("Drive トークン失効(401)なら手動分 + 再連携ヒントを返す", async () => {
    authMock.mockResolvedValue(signedIn());
    tokenMock.mockResolvedValue("ya29.stale");
    vi.stubGlobal(
      "fetch",
      routeFetch((u) =>
        u.includes("/drive/") ? { status: 401, body: {} } : undefined,
      ),
    );
    const res = await app.request("/api/registry", {}, baseEnv);
    const body = (await res.json()) as {
      apps: unknown[];
      source: { userAuthExpired?: boolean };
    };
    expect(body.source.userAuthExpired).toBe(true);
    expect(body.apps).toHaveLength(1); // 手動分のみ
  });

  it("Apps Script API 未有効(全403)なら手動分+ヒントを返す", async () => {
    authMock.mockResolvedValue(signedIn());
    tokenMock.mockResolvedValue("ya29.at");
    vi.stubGlobal(
      "fetch",
      routeFetch((u) => {
        if (u.includes("/drive/"))
          return { body: { files: [{ id: "SID9", name: "x" }] } };
        return { status: 403, body: {} };
      }),
    );
    const res = await app.request("/api/registry", {}, baseEnv);
    const body = (await res.json()) as {
      source: { appsScriptApiDisabled?: boolean };
    };
    expect(body.source.appsScriptApiDisabled).toBe(true);
  });

  it("Google 未連携(トークン無し)なら手動へフォールバック", async () => {
    authMock.mockResolvedValue(signedIn());
    tokenMock.mockResolvedValue(null);
    const res = await app.request("/api/registry", {}, baseEnv);
    const body = (await res.json()) as { source: { mode: string } };
    expect(body.source.mode).toBe("manual");
  });

  it("未サインインは手動へフォールバック(ユーザーモードに入らない)", async () => {
    authMock.mockResolvedValue({
      configured: true,
      status: "signed-out",
      signInUrl: "https://accounts.example.dev/sign-in",
      headers: new Headers(),
    });
    const res = await app.request("/api/registry", {}, baseEnv);
    const body = (await res.json()) as { source: { mode: string } };
    expect(body.source.mode).toBe("manual");
    expect(tokenMock).not.toHaveBeenCalled();
  });
});
