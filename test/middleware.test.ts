import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/_middleware";
import type { Env } from "../src/server/app";
import { createSessionToken, SESSION_COOKIE } from "../src/server/auth/session";

const SECRET = "test-secret-value-do-not-use-in-prod";

const NEXT = new Response("SERVED", { status: 200 });

function makeContext(request: Request, env: Partial<Env> = {}) {
  const next = vi.fn(async () => NEXT);
  return {
    context: { request, env: env as Env, next },
    next,
  };
}

describe("_middleware auth gate", () => {
  it("AUTH_SECRET 未設定は fail-closed (503, next呼ばない)", async () => {
    const { context, next } = makeContext(
      new Request("https://portal.example.com/"),
    );
    const res = await onRequest(context);
    expect(res.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("公開パス(/api/auth/login)は認証なしで通す", async () => {
    const { context, next } = makeContext(
      new Request("https://portal.example.com/api/auth/login"),
      { AUTH_SECRET: SECRET },
    );
    const res = await onRequest(context);
    expect(res).toBe(NEXT);
    expect(next).toHaveBeenCalledOnce();
  });

  it("有効なセッションCookieがあれば通す", async () => {
    const token = await createSessionToken(
      { email: "taro@example.co.jp" },
      SECRET,
      24,
    );
    const { context, next } = makeContext(
      new Request("https://portal.example.com/", {
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
      { AUTH_SECRET: SECRET },
    );
    const res = await onRequest(context);
    expect(res).toBe(NEXT);
    expect(next).toHaveBeenCalledOnce();
  });

  it("未認証の画面遷移はログインへ302 (redirect付き)", async () => {
    const { context, next } = makeContext(
      new Request("https://portal.example.com/tools?x=1", {
        headers: { accept: "text/html" },
      }),
      { AUTH_SECRET: SECRET },
    );
    const res = await onRequest(context);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/api/auth/login");
    expect(loc.searchParams.get("redirect")).toBe("/tools?x=1");
    expect(next).not.toHaveBeenCalled();
  });

  it("未認証のAPIリクエストは401(JSON)", async () => {
    const { context, next } = makeContext(
      new Request("https://portal.example.com/api/apps", {
        headers: { accept: "application/json" },
      }),
      { AUTH_SECRET: SECRET },
    );
    const res = await onRequest(context);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(next).not.toHaveBeenCalled();
  });
});
