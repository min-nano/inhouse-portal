import { describe, expect, it } from "vitest";
import { createApp, type Env } from "../src/worker/app";
import { loadRegistry } from "../src/worker/registry";

const registry = loadRegistry({
  apps: [
    {
      id: "tool-a",
      name: "ツールA",
      description: "テスト用",
      category: "設計",
      tags: ["gas"],
      url: "https://script.google.com/macros/s/AAA/exec",
    },
    {
      id: "tool-b",
      name: "ツールB",
      description: "テスト用",
      category: "業務",
      tags: [],
      url: "https://example.com/b",
    },
  ],
});

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {
      fetch: async () => new Response("static-asset", { status: 200 }),
    },
    ...overrides,
  };
}

const app = createApp(registry);

describe("GET /api/health", () => {
  it("okを返す", async () => {
    const res = await app.request("/api/health", {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /api/apps", () => {
  it("台帳のアプリとカテゴリ一覧を返す", async () => {
    const res = await app.request("/api/apps", {}, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      apps: { id: string }[];
      categories: string[];
    };
    expect(body.apps.map((a) => a.id)).toEqual(["tool-a", "tool-b"]);
    expect(body.categories).toEqual(["設計", "業務"]);
  });
});

describe("未定義のAPIパス", () => {
  it("404(JSON)を返す", async () => {
    const res = await app.request("/api/nope", {}, makeEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("API以外のパス", () => {
  it("静的アセットに委譲する", async () => {
    const res = await app.request("/some/page", {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("static-asset");
  });
});

describe("PROXY_TARGETS が壊れている場合", () => {
  it("/api/proxy/:id は500を返す", async () => {
    const res = await app.request(
      "/api/proxy/tool-a",
      {},
      makeEnv({ PROXY_TARGETS: "{not-json" }),
    );
    expect(res.status).toBe(500);
  });
});
