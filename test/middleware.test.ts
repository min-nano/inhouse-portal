import { beforeEach, describe, expect, it, vi } from "vitest";

// Clerk ラッパーはモックし、middleware のゲート判定(handshake / 302・401 / fail-closed /
// サインイン済みは通す)だけを検証する。許可制御は Clerk 側にあるので、サインインできた=許可済み。
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

describe("_middleware auth gate (Clerk)", () => {
  it("Clerk 未設定は fail-closed (503, next呼ばない)", async () => {
    setAuth({ configured: false });
    const { context, next } = makeContext(
      new Request("https://portal.example.com/"),
    );
    const res = await onRequest(context);
    expect(res.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("公開パス(/api/health)は認証なしで通す(authenticate も呼ばない)", async () => {
    const { context, next } = makeContext(
      new Request("https://portal.example.com/api/health"),
    );
    const res = await onRequest(context);
    expect(res).toBe(NEXT);
    expect(next).toHaveBeenCalledOnce();
    expect(authMock).not.toHaveBeenCalled();
  });

  it("handshake は Clerk のヘッダをそのまま返す(307)", async () => {
    const headers = new Headers({ location: "https://clerk.example/handshake" });
    setAuth({ configured: true, status: "handshake", headers });
    const { context, next } = makeContext(
      new Request("https://portal.example.com/", {
        headers: { accept: "text/html" },
      }),
    );
    const res = await onRequest(context);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://clerk.example/handshake");
    expect(next).not.toHaveBeenCalled();
  });

  it("サインイン済みなら通す(許可制御は Clerk 側)", async () => {
    setAuth({
      configured: true,
      status: "signed-in",
      client: {} as never,
      userId: "u1",
      sessionClaims: { email: "taro@example.co.jp" },
      headers: new Headers(),
    });
    const { context, next } = makeContext(
      new Request("https://portal.example.com/"),
    );
    const res = await onRequest(context);
    expect(res).toBe(NEXT);
    expect(next).toHaveBeenCalledOnce();
  });

  it("未サインインの画面遷移は Clerk サインインへ 302 (redirect_url付き)", async () => {
    setAuth({
      configured: true,
      status: "signed-out",
      signInUrl: "https://accounts.example.dev/sign-in",
      headers: new Headers(),
    });
    const { context, next } = makeContext(
      new Request("https://portal.example.com/tools?x=1", {
        headers: { accept: "text/html" },
      }),
    );
    const res = await onRequest(context);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(
      "https://accounts.example.dev/sign-in",
    );
    expect(loc.searchParams.get("redirect_url")).toBe(
      "https://portal.example.com/tools?x=1",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("未サインインの API リクエストは 401(JSON)", async () => {
    setAuth({
      configured: true,
      status: "signed-out",
      signInUrl: "https://accounts.example.dev/sign-in",
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
});
