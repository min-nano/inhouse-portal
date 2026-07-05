import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
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
