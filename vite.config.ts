import { defineConfig } from "vite";

// クライアント(ClerkJS)用の Publishable key を **サーバーと同じ環境変数名**
// `CLERK_PUBLISHABLE_KEY` から注入する。vite は既定で `VITE_` 接頭辞の変数しか
// クライアントへ出さないが、`define` で当該キーだけをコンパイル時定数に焼き込むことで、
// デプロイ環境に登録する変数を1つ(`CLERK_PUBLISHABLE_KEY`)に統一できる。
//
// ⚠️ ここで注入するのは Publishable key(`pk_…`、公開値)のみ。`envPrefix` に `CLERK_`
// を足すと `CLERK_SECRET_KEY` までクライアントに漏れるため、その方法は使わない。
export default defineConfig({
  root: "web",
  define: {
    __CLERK_PUBLISHABLE_KEY__: JSON.stringify(
      process.env.CLERK_PUBLISHABLE_KEY ?? "",
    ),
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    // vite単体でUI開発するとき、APIは wrangler pages dev (8788) に中継する
    proxy: {
      "/api": "http://localhost:8788",
    },
  },
});
