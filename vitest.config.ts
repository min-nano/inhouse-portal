import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // GitHub Code Quality はCobertura XML形式を取り込む。textはCIログ確認用。
      reporter: ["text", "cobertura"],
      reportsDirectory: "coverage",
      include: ["src/**", "functions/**"],
    },
  },
});
