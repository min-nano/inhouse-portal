import { handle } from "hono/cloudflare-pages";
import rawApps from "../../data/apps.json";
import { createApp } from "../../src/server/app";
import { loadRegistry } from "../../src/server/registry";

// デプロイ時にビルドへ焼き込まれる台帳。不正データはビルド/デプロイ時に検出される。
const registry = loadRegistry(rawApps);
const app = createApp(registry);

// functions/api/[[route]].ts に置くことで /api/* への全リクエストがこの
// Function に振り分けられる。それ以外(画面などの静的アセット)はPagesが直接配信する。
export const onRequest = handle(app);
