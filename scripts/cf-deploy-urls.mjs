/**
 * Cloudflare Pages API から「今デプロイされた1件」のURLを解決する。
 *
 * デプロイ毎に変わるユニークURL(`https://<hash>.<project>.pages.dev`)と
 * ブランチエイリアス(`aliases`)は固定値ではないため、commit SHA で当該デプロイを
 * 特定して取り出す。post-deploy-smoke ワークフローが解決結果を scripts/smoke.mjs へ渡す。
 *
 * 入力(環境変数):
 *   CF_API_TOKEN     … Cloudflare API トークン(Account → Cloudflare Pages → Read)
 *   CF_ACCOUNT_ID    … アカウントID
 *   CF_PAGES_PROJECT … Pages プロジェクト名(例: inhouse-portal)
 *   COMMIT_SHA       … 対象デプロイの commit SHA(deployment.sha)
 *   DEPLOY_ENV       … "production" | "preview"(API の env フィルタ)
 *   CF_API_BASE      … (任意)APIベースURL上書き。テスト用
 *
 * 出力: 解決したURLを1行1件で stdout に出す(url + aliases、重複除去)。
 * 失敗時(トークン無し/API失敗/該当なし)は stderr に警告を出し **exit 0 で空出力**。
 * ここで落とすと本命のスモークテストごと失敗してしまうため、呼び出し側の
 * フォールバック(environment_url など)に委ねる。
 */

const API_BASE = process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4";

function warn(msg) {
  process.stderr.write(`cf-deploy-urls: ${msg}\n`);
}

async function main() {
  const token = process.env.CF_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID;
  const project = process.env.CF_PAGES_PROJECT;
  const sha = process.env.COMMIT_SHA;
  const env = process.env.DEPLOY_ENV === "production" ? "production" : "preview";

  if (!token || !account || !project) {
    warn("CF_API_TOKEN / CF_ACCOUNT_ID / CF_PAGES_PROJECT が未設定。解決をスキップ。");
    return;
  }
  if (!sha) {
    warn("COMMIT_SHA が空。解決をスキップ。");
    return;
  }

  const url =
    `${API_BASE}/accounts/${account}/pages/projects/${project}` +
    `/deployments?env=${env}&per_page=25`;

  let body;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      warn(`API が ${res.status} を返した。解決をスキップ。`);
      return;
    }
    body = await res.json();
  } catch (e) {
    warn(`API 呼び出し失敗: ${e.message}。解決をスキップ。`);
    return;
  }

  const list = Array.isArray(body?.result) ? body.result : [];
  // commit SHA が一致するデプロイ(新しい順)。完全一致優先、無ければ前方一致。
  const commitOf = (d) => d?.deployment_trigger?.metadata?.commit_hash ?? "";
  let match = list.find((d) => commitOf(d) === sha);
  if (!match) match = list.find((d) => commitOf(d).startsWith(sha) || sha.startsWith(commitOf(d) || "\0"));
  if (!match) {
    warn(`SHA ${sha} に一致するデプロイが見つからない。解決をスキップ。`);
    return;
  }

  const urls = [];
  if (typeof match.url === "string") urls.push(match.url);
  if (Array.isArray(match.aliases)) {
    for (const a of match.aliases) if (typeof a === "string") urls.push(a);
  }
  const unique = [...new Set(urls.map((u) => u.replace(/\/+$/, "")))];
  if (unique.length === 0) {
    warn("デプロイに url / aliases が無い。解決をスキップ。");
    return;
  }
  process.stdout.write(unique.join("\n") + "\n");
}

main();
