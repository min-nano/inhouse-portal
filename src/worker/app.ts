import { Hono } from "hono";
import { listCategories, type Registry } from "./registry";
import { parseProxyTargets, proxyRequest } from "./proxy";

/** 静的アセットバインディング (Cloudflare Workers Static Assets) */
type AssetsFetcher = { fetch: (request: Request) => Promise<Response> };

export type Env = {
  ASSETS: AssetsFetcher;
  /** JSON文字列: {"appId": "https://script.google.com/.../exec"} */
  PROXY_TARGETS?: string;
};

export function createApp(registry: Registry) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/apps", (c) =>
    c.json({
      apps: registry.apps,
      categories: listCategories(registry),
    }),
  );

  app.all("/api/proxy/:id", async (c) => {
    let targets;
    try {
      targets = parseProxyTargets(c.env.PROXY_TARGETS);
    } catch {
      return c.json({ error: "PROXY_TARGETS の設定が不正です" }, 500);
    }
    return proxyRequest(targets, c.req.param("id"), c.req.raw);
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // API以外は静的アセット (SPAフォールバック込み) に委譲
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
