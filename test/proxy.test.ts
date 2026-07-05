import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProxyTargets, proxyRequest } from "../src/server/proxy";

const TARGETS = {
  "kintai-api": "https://script.google.com/macros/s/SECRET/exec",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseProxyTargets", () => {
  it("未設定・空文字は空マップを返す", () => {
    expect(parseProxyTargets(undefined)).toEqual({});
    expect(parseProxyTargets("")).toEqual({});
  });

  it("正しいJSONマップをパースする", () => {
    expect(parseProxyTargets(JSON.stringify(TARGETS))).toEqual(TARGETS);
  });

  it("オブジェクト以外のJSONを拒否する", () => {
    expect(() => parseProxyTargets('["a"]')).toThrow();
    expect(() => parseProxyTargets('"str"')).toThrow();
  });

  it("https以外のURLを拒否する", () => {
    expect(() =>
      parseProxyTargets('{"x":"http://insecure.example.com"}'),
    ).toThrow(/https/);
  });
});

describe("proxyRequest", () => {
  it("未登録のidは404を返す(上流にfetchしない)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await proxyRequest(
      TARGETS,
      "unknown",
      new Request("https://portal.example.com/api/proxy/unknown"),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GET/POST以外のメソッドは405を返す", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await proxyRequest(
      TARGETS,
      "kintai-api",
      new Request("https://portal.example.com/api/proxy/kintai-api", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GETをクエリ付きで上流へ転送し、レスポンスを返す", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response('{"result":"ok"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "secret=1",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyRequest(
      TARGETS,
      "kintai-api",
      new Request(
        "https://portal.example.com/api/proxy/kintai-api?month=2026-07&user=abc",
      ),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    const url = new URL(calledUrl);
    expect(url.origin + url.pathname).toBe(
      "https://script.google.com/macros/s/SECRET/exec",
    );
    expect(url.searchParams.get("month")).toBe("2026-07");
    expect(url.searchParams.get("user")).toBe("abc");
    expect(calledInit.redirect).toBe("follow");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "ok" });
    // GASの生URLやCookieが漏れないこと
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("POSTのボディとContent-Typeを引き継ぐ", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("accepted", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await proxyRequest(
      TARGETS,
      "kintai-api",
      new Request("https://portal.example.com/api/proxy/kintai-api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    );

    const [, calledInit] = fetchMock.mock.calls[0]!;
    expect(calledInit.method).toBe("POST");
    expect(new TextDecoder().decode(calledInit.body as ArrayBuffer)).toBe(
      '{"hello":"world"}',
    );
    expect(
      (calledInit.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");
  });
});
