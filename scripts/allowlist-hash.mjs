/**
 * 許可リスト(KV)に入れる個別メールの HMAC ハッシュを算出する。
 *
 * KV には個人メールを平文で置かず、`HMAC-SHA256(AUTH_SECRET, "allowlist:"+email)` の
 * hex を `emailHashes` に入れる(KV 閲覧者が候補メールを総当たりしても、AUTH_SECRET を
 * 知らない限り一致判定できない)。この算出方法は
 * src/server/auth/allowlist.ts の allowlistEmailHash と一致している。
 *
 * 使い方:
 *   AUTH_SECRET=... node scripts/allowlist-hash.mjs taro@partner.com hanako@partner.co.jp
 *
 * 出力(KV の allowlist キーへ):
 *   { "domains": ["example.co.jp"], "emailHashes": ["<hex>", ...] }
 */
import { createHmac } from "node:crypto";

const secret = process.env.AUTH_SECRET;
if (!secret) {
  console.error("AUTH_SECRET を環境変数で渡してください");
  process.exit(1);
}
const emails = process.argv.slice(2);
if (emails.length === 0) {
  console.error(
    "使い方: AUTH_SECRET=... node scripts/allowlist-hash.mjs <email> [email2 ...]",
  );
  process.exit(1);
}

const emailHashes = emails.map((raw) => {
  const email = raw.trim().toLowerCase();
  return createHmac("sha256", secret).update(`allowlist:${email}`).digest("hex");
});

// そのまま KV に貼れる形で出力(domains は必要に応じて編集)
console.log(JSON.stringify({ domains: [], emailHashes }, null, 2));
