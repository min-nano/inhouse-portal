import { Hono } from "hono";
import { listCategories, type Registry } from "./registry";
import { parseProxyTargets, proxyRequest } from "./proxy";

export type Env = {
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

  // このHonoアプリはPages Function (functions/api/[[route]].ts) として
  // /api/* だけを担当する。画面などの静的アセットはPagesが直接配信するため、
  // ここでは未定義のAPIパスを404で返すだけでよい。
  app.all("*", (c) => c.json({ error: "not found" }, 404));

  return app;
}
