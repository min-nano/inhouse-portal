import { beforeEach, describe, expect, it, vi } from "vitest";

// Clerk ラッパーはモックし、middleware のゲート判定だけを検証する。
// 新モデル: 画面(静的アセット)は公開、保護は /api/* のみ(未サインイン/handshake は 401)。
// 許可制御は Clerk 側にあるので、サインインできた=許可済み。
vi.mock("../src/server/auth/clerk", () => ({
  authenticate: vi.fn(),
}));

import { authenticate } from "../src/server/auth/clerk";
import { onRequest } from "../functions/_middleware";
import type { Env } from "../src/server/app";
import type { ClerkAuth } from "../src/server/auth/clerk";

const authMock = authenticate as unknown as ReturnType<typeof vi.fn>;
const NEXT = new Response("SERVED", { status: 200 });

function makeContext(request: Request, env: Partial<Env> = {}) {
  const next = vi.fn(async () => NEXT);
  return { context: { request, env: env as Env, next }, next };
}

function setAuth(result: ClerkAuth) {
  authMock.mockResolvedValue(result);
}

beforeEach(() => {
  authMock.mockReset();
});

describe("_middleware auth gate (Clerk, API のみゲート)", () => {
  it("画面(静的アセット)は公開: 認証せず通す", async () => {
    const { context, next } = makeContext(
      new Request("https://portal.example.com/", {
        headers: { accept: "text/html" },
      }),
    );
    const res = await onRequest(context);
    expect(res).toBe(NEXT);
    expect(next).toHaveBeenCalledOnce();
    expect(authMock).not.toHaveBeenCalled();
  });

  it("公開 API(/api/health)は認証なしで通す(authenticate も呼ばない)", async () => {
    const { context, next } = makeContext(
      new Request("https://portal.example.com/api/health"),
    );
    const res = await onRequest(context);
    expect(res).toBe(NEXT);
    expect(next).toHaveBeenCalledOnce();
    expect(authMock).not.toHaveBeenCalled();
  });

  it("Clerk 未設定は /api/* で fail-closed (503, next呼ばない)", async () => {
    setAuth({ configured: false });
    const { context, next } = makeContext(
      new Request("https://portal.example.com/api/apps"),
    );
    const res = await onRequest(context);
    expect(res.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("サインイン済みの API は通す(許可制御は Clerk 側)", async () => {
    setAuth({
      configured: true,
      status: "signed-in",
      client: {} as never,
      userId: "u1",
      sessionClaims: { email: "taro@example.co.jp" },
      headers: new Headers(),
    });
    const { context, next } = makeContext(
      new Request("https://portal.example.com/api/registry"),
    );
    const res = await onRequest(context);
    expect(res).toBe(NEXT);
    expect(next).toHaveBeenCalledOnce();
  });

  it("サインイン済みは Clerk の Cookie 更新を伝播する", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "__session=refreshed; Path=/");
    setAuth({
      configured: true,
      status: "signed-in",
      client: {} as never,
      userId: "u1",
      sessionClaims: {},
      headers,
    });
    const { context } = makeContext(
      new Request("https://portal.example.com/api/registry"),
    );
    const res = await onRequest(context);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("__session=refreshed");
  });

  it("未サインインの API は 401(JSON、リダイレクトしない)", async () => {
    setAuth({
      configured: true,
      status: "signed-out",
      headers: new Headers(),
    });
    const { context, next } = makeContext(
      new Request("https://portal.example.com/api/apps", {
        headers: { accept: "application/json" },
      }),
    );
    const res = await onRequest(context);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(next).not.toHaveBeenCalled();
  });

  it("handshake の API も 401(fetch を壊さないため 3xx にしない)", async () => {
    const headers = new Headers({ location: "https://clerk.example/handshake" });
    setAuth({ configured: true, status: "handshake", headers });
    const { context, next } = makeContext(
      new Request("https://portal.example.com/api/registry"),
    );
    const res = await onRequest(context);
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
