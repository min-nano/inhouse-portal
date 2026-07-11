/**
 * `${VAR}` プレースホルダを環境変数で置換してテンプレートを実ファイル化する。
 * clasp 設定 (gas/.clasp.json / gas/.clasprc.json) を *.example から生成するのに使う。
 * envsubst 相当の処理を Node だけで行い、CI/ローカルどちらでも動くようにする。
 *
 * 使い方:
 *   CLASP_SCRIPT_ID=... node scripts/render-template.mjs gas/.clasp.json.example gas/.clasp.json
 *
 * 未定義の変数が残っている場合はエラーにする(空文字で握りつぶさない)。
 */
import { readFileSync, writeFileSync } from "node:fs";

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error(
    "使い方: node scripts/render-template.mjs <template> <output>",
  );
  process.exit(1);
}

const missing = new Set();
const rendered = readFileSync(src, "utf8").replace(
  /\$\{(\w+)\}/g,
  (_, name) => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      missing.add(name);
      return "";
    }
    return value;
  },
);

if (missing.size > 0) {
  console.error(
    `未設定の環境変数: ${[...missing].join(", ")} (${src})`,
  );
  process.exit(1);
}

writeFileSync(dest, rendered);
console.error(`rendered ${src} -> ${dest}`);
